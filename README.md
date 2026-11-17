# ParkSlot: parking slot booking prototype

Find parking near where you're going, see every slot's live status, book a slot for _n_ hours, pay online, and get a booking ID to show on arrival. Drivers use the app at `/`; parking staff use a separate admin portal at `/admin/`. Built from the requirements in [Instructions.md](Instructions.md).

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there are no native dependencies).

```bash
npm install
npm start            # http://localhost:3000
npm test             # booking-rule tests
```

The first start seeds 12 demo parking spots around the default map centre, plus a demo account:

| What | Value |
|---|---|
| Driver app | http://localhost:3000, login `demo@parking.test` / `demo1234` |
| Admin portal | http://localhost:3000/admin/, login `admin@parking.test` / `admin1234` |
| Test card (success) | `4242 4242 4242 4242`, any future expiry, any CVC |
| Test card (declined) | `4000 0000 0000 0002` |

To seed somewhere else: `npm run seed -- --lat 12.9716 --lng 77.5946 --reset`, and set `DEFAULT_LAT` / `DEFAULT_LNG` so the map opens there.

The demo admin is created on start-up whenever no admin account exists. To add a real one (sign-up only ever creates driver accounts):

```bash
npm run create-admin -- --name "Asha Rao" --email asha@example.com --password 'a-long-password'
```

## How the requirements are met

| Requirement | Implementation |
|---|---|
| Nearby parking around a chosen location | Search a place (OpenStreetMap Nominatim), use your location, or click the map. `GET /api/spots?lat&lng&radius` returns spots within 3 km, nearest first (bounding box in SQL, then haversine). |
| Every slot's status in a spot | `GET /api/spots/:id?start&hours` returns each slot as **free**, **booked** (paid or mid-checkout), or **occupied** (driver checked in) for the chosen window, plus its upcoming booked times. |
| Book for _n_ hours, charged hourly | Choose an arrival time (up to 7 days ahead) and 1–24 whole hours. Price = `hourly_rate × hours`. |
| No double booking | Checking for an overlapping booking and inserting the new one happen in a single `BEGIN IMMEDIATE` SQLite transaction, so two requests cannot both pass the check. See [Booking lifecycle](#booking-lifecycle). |
| Unique booking ID, arrive any time in the window | On successful payment the booking gets a random code such as `PK-7F3K-9QX2` (unique in the DB; letters/digits that look alike are left out). Admin check-in accepts it any time in `[start, end)`, once. |
| Online payment only | No cash or pay-later path exists. A booking is only confirmed, and only gets its ID, after an online charge succeeds. |
| Separate admin and user portals | Every account has a role, `user` (driver) or `admin`. Drivers sign in at `/` through `/api/auth/*`; admins sign in at `/admin/` through `/api/admin/auth/*`. Each login endpoint turns away the other role, and every protected endpoint checks the session's role, so a driver session gets `403` from `/api/admin/*` and an admin session gets `403` from the driver booking API. The two portals keep their sessions under different browser storage keys. |
| Welcome email | Signing up sends the new driver a welcome email: how to book, where to find their bookings, and what to do if they didn't create the account. It is sent in the background, so a slow or failing mail server never delays or breaks sign-up (failures are logged). |
| Password reset | **Log in → Forgot password?** emails a reset link (`/#reset=<token>`). The link works once, expires after 30 minutes, signs the driver in, and signs out every other session. The request endpoint gives the same answer whether or not an account exists, sends at most one email per account per minute, and ignores admin accounts. Only a SHA-256 hash of each token is stored. |
| Booking history | `GET /api/bookings?scope=history` pages through a driver's past paid bookings (completed, not used, or cancelled and refunded), newest first. `scope=upcoming` lists holds and bookings that have not ended. `GET /api/bookings/:id` returns one booking with every payment attempt and refund. The app shows these under **My bookings → Upcoming / History → Details**. |

## Booking lifecycle

```
            createHold                     pay (charge ok)              check-in at gate
  (free) ─────────────► pending_payment ─────────────────► confirmed ─────────────────► checked_in
                         │  holds slot 10 min               │ has booking ID              │ slot "occupied"
                         │                                  │                             │
                         ├─ hold lapses ─► expired          ├─ cancel before start ─►     └─ window ends ─► completed
                         └─ user cancels ─► cancelled       │  cancelled + refund
                                                            └─ window ends unused ─► lapsed
```

- **Holds.** Clicking "Continue to payment" reserves the slot for 10 minutes, so nobody else can take it while the user types card details.
- **Slow-payment race.** If a hold runs out while the gateway is still processing, and someone else books the slot in that gap, the late payment is detected when it tries to confirm and is **refunded automatically**. A duplicate "pay" click is handled the same way. `test/bookings.test.js` covers this.
- `expired`, `lapsed` and `completed` depend only on the clock, so they are worked out when bookings are read, not stored.

## Project layout

```
src/
  server.js              entry point (auto-seeds an empty DB)
  app.js                 Express routes + error handling
  config.js              env-driven settings
  db.js                  schema, connection, transaction helper
  seed.js                demo data (also a CLI: npm run seed)
  create-admin.js        CLI: npm run create-admin
  services/
    availability.js      window validation, overlap/conflict checks, slot statuses
    bookings.js          hold → pay → confirm, cancel/refund, check-in, booking lists/history
    spots.js             nearby search, spot detail
    payments.js          mock payment gateway (charge/refund)
    mailer.js            SMTP mailer (nodemailer) or console mailer, chosen from env
    emails.js            email templates: welcome, password reset
    auth.js              accounts and roles, scrypt password hashing, sessions
public/                  static frontend (vanilla JS + Leaflet, no build step)
  index.html, app.js     driver app
  admin/                 admin portal: check-in and all bookings
  common.js, styles.css  shared by both
test/
  bookings.test.js       booking rules, history and admin search (service level)
  password-reset.test.js reset links: expiry, single use, throttling, session sign-out
  email.test.js          welcome email, SMTP delivery against a fake SMTP server, mailer failures
  portals.test.js        portal separation and API flows over HTTP
```

## API

"Driver" and "Admin" mean a Bearer token from that portal's login. A token of the wrong role gets `403`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config` | – | currency, default map centre, limits |
| POST | `/api/auth/register` · `/api/auth/login` | – | driver sign-up / sign-in, returns `{ token, user }` |
| GET | `/api/auth/me` · POST `/api/auth/logout` | Driver | session |
| POST | `/api/auth/password-reset/request` `{ email }` | – | email a reset link; always `202` with the same message |
| POST | `/api/auth/password-reset/confirm` `{ token, password }` | – | set the new password, returns `{ token, user }`; a bad or expired token gives `400` with `reason: "invalid_reset_token"` |
| GET | `/api/spots?lat=&lng=&radius=` | – | nearby spots with free/total counts |
| GET | `/api/spots/:id?start=&hours=` | – | slot statuses for a window |
| POST | `/api/bookings` `{ slotId, startAt, hours }` | Driver | create a 10-minute hold |
| POST | `/api/bookings/:id/pay` `{ card }` | Driver | charge, then confirm and issue the code |
| POST | `/api/bookings/:id/cancel` | Driver | release a hold, or cancel and refund before start |
| GET | `/api/bookings?scope=&limit=&offset=` | Driver | my bookings: `scope` is `all` (default), `upcoming` or `history` |
| GET | `/api/bookings/:id` | Driver | one of my bookings with its `payments` |
| POST | `/api/admin/auth/login` | – | admin sign-in, returns `{ token, user }` |
| GET | `/api/admin/auth/me` · POST `/api/admin/auth/logout` | Admin | session |
| POST | `/api/admin/checkin` `{ code }` | Admin | validate the code at arrival |
| GET | `/api/admin/bookings?q=&scope=&limit=&offset=` | Admin | all bookings; `q` matches code, driver name or email |
| GET | `/api/admin/bookings/:id` | Admin | any booking with driver details and `payments` |

Booking lists return `{ bookings, has_more, next_offset }`. `limit` defaults to 20 (max 100). Times are epoch milliseconds. Amounts are in the currency's smallest unit (e.g. paise).

## Configuration

| Env var | Default |
|---|---|
| `PORT` | `3000` |
| `PUBLIC_URL` | `http://localhost:$PORT` (base URL for links in emails) |
| `SMTP_HOST` | unset: emails are printed to the console instead of sent |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `true` when `SMTP_PORT` is 465, otherwise `false` (STARTTLS is used when the server offers it) |
| `SMTP_USER`, `SMTP_PASS` | unset: no SMTP login |
| `MAIL_FROM` | required when `SMTP_HOST` is set, e.g. `ParkSlot <no-reply@example.com>` |

`npm start` and `npm run dev` load a `.env` file if there is one (gitignored). `.env.example` lists the settings.

### Sending real email

Set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` for any SMTP provider (Amazon SES, Postmark, Mailgun, SendGrid, Gmail with an app password, …) and set `PUBLIC_URL` to the site's real address. At start-up the server says which mode it is in, and warns if it cannot reach or log in to the SMTP server. If `MAIL_FROM` is missing, the server refuses to start.
| `DB_FILE` | `data/parking.db` |
| `CURRENCY` | `INR` |
| `DEFAULT_LAT`, `DEFAULT_LNG` | `28.6315`, `77.2167` (New Delhi) |

## Prototype limitations / next steps

- **Payments are mocked.** `services/payments.js` has the `charge`/`refund` interface a real adapter (Razorpay, Stripe, …) would implement. In production, card details should go to the provider's hosted checkout and never touch this server (PCI-DSS), and a payment webhook should confirm bookings.
- **Emails are sent once, in the background.** A failed send is logged but not retried. A production setup would put emails on a queue with retries, or use a provider's HTTP API with delivery webhooks.
- **Email addresses are not verified.** Anyone can sign up with any address. The welcome email tells the owner how to take the account over, but sign-up does not require confirming the address.
- **Admins cannot reset their own password.** Reset is for driver accounts only; admin accounts are managed from the CLI.
- **Parking data is seeded.** Real spots could come from operator onboarding or OpenStreetMap (`amenity=parking` via the Overpass API). Slot occupancy could come from gate sensors or ANPR cameras.
- **Admins are not tied to spots.** Any admin can check in any booking and see every booking. Linking admins to the spots they staff would stop a code being checked in at the wrong spot.
- **The demo admin has a published password.** Outside a demo, create a real admin with `npm run create-admin` and delete the demo account.
- **Only one server process should write.** SQLite with `BEGIN IMMEDIATE` is safe for this. To scale out, move to Postgres and use an exclusion constraint on `(slot_id, tstzrange(start_at, end_at))` to enforce no-overlap in the database itself.
