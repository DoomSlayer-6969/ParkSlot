# ParkSlot: parking slot booking prototype

Find parking near where you're going, see every slot's live status, book a slot for _n_ hours at a price that follows live traffic and the lot's size, pay online, and get a QR code pass that staff scan on arrival. The demo lots sit next to Delhi metro stations. Drivers use the app at `/`; parking staff use a separate admin portal at `/admin/`. Built from the requirements in [Instructions.md](Instructions.md).

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there are no native dependencies).

```bash
npm install
npm start            # http://localhost:3000
npm test             # all tests
```

The first start seeds a parking lot near each of the 203 Delhi metro stations (see [Metro stations](#metro-stations-and-demo-data)), plus demo accounts. For traffic-based prices, put a free TomTom API key in `.env` (see [Live traffic](#live-traffic)); without one, prices depend on lot size only.

| What | Value |
|---|---|
| Driver app | http://localhost:3000, login `demo@parking.test` / `demo1234` |
| Admin portal | http://localhost:3000/admin/, login `admin@parking.test` / `admin1234` |
| Test card (success) | `4242 4242 4242 4242`, any future expiry, any CVC |
| Test card (declined) | `4000 0000 0000 0002` |

To replace the demo data (this deletes all bookings): `npm run seed -- --reset`.

The demo admin is created on start-up whenever no admin account exists. To add a real one (sign-up only ever creates driver accounts):

```bash
npm run create-admin -- --name "Asha Rao" --email asha@example.com --password 'a-long-password'
```

## How the requirements are met

| Requirement | Implementation |
|---|---|
| Nearby parking around a chosen location | Search a place (OpenStreetMap Nominatim), use your location, or click the map. `GET /api/spots?lat&lng&radius` returns spots within `SEARCH_RADIUS_KM` (3 km), nearest first (bounding box in SQL, then haversine). |
| Lots near Delhi metro stations | The demo seed puts a lot at a random spot 80–450 m from each Delhi metro station. Station positions come from OpenStreetMap (`npm run fetch-stations`). See [Metro stations](#metro-stations-and-demo-data). |
| Price depends on traffic and lot size | hourly rate = base × traffic factor × lot-size factor. Traffic comes from TomTom's free live traffic API; smaller lots cost more. See [Pricing](#pricing). |
| Settings in environment variables | Every rate, limit, timeout, URL and demo-data setting is read from the environment with a default; `.env.example` lists them all. Invalid values stop start-up with a message naming the variable. |
| Every slot's status in a spot | `GET /api/spots/:id?start&hours` returns each slot as **free**, **booked** (paid or mid-checkout), or **occupied** (driver checked in) for the chosen window, plus its upcoming booked times. |
| Book for _n_ hours, charged hourly | Choose an arrival time (up to `MAX_ADVANCE_DAYS`, 7 days, ahead) and 1–`MAX_BOOKING_HOURS` (24) whole hours. Amount = the lot's current hourly rate × hours, fixed when the slot is held. |
| No double booking | Checking for an overlapping booking and inserting the new one happen in a single `BEGIN IMMEDIATE` SQLite transaction, so two requests cannot both pass the check. See [Booking lifecycle](#booking-lifecycle). |
| QR check-in, arrive any time in the window | On successful payment the booking gets a **QR pass**: a QR code holding a secret 128-bit check-in token (`PARKSLOT:<32 hex chars>`), shown to the driver after payment and under **My bookings → Show QR code**, with **Save image** for car parks without signal. Staff scan it in the admin portal with the device camera or a handheld USB/Bluetooth scanner. A pass works once, only within `[start, end)`, and only for its own booking. See [Check-in](#check-in). |
| Booking reference | Each paid booking also gets a reference such as `PK-7F3K-9QX2` (unique; letters/digits that look alike are left out). It is shown on the booking's details and is searchable in the admin portal, for support. It **cannot** check anyone in. |
| Online payment only | No cash or pay-later path exists. A booking is only confirmed, and only gets its ID, after an online charge succeeds. |
| Separate admin and user portals | Every account has a role, `user` (driver) or `admin`. Drivers sign in at `/` through `/api/auth/*`; admins sign in at `/admin/` through `/api/admin/auth/*`. Each login endpoint turns away the other role, and every protected endpoint checks the session's role, so a driver session gets `403` from `/api/admin/*` and an admin session gets `403` from the driver booking API. The two portals keep their sessions under different browser storage keys. |
| Welcome email | Signing up sends the new driver a welcome email: how to book, where to find their bookings, and what to do if they didn't create the account. It is sent in the background, so a slow or failing mail server never delays or breaks sign-up (failures are logged). |
| Password reset | **Log in → Forgot password?** emails a reset link (`/#reset=<token>`). The link works once, expires after 30 minutes, signs the driver in, and signs out every other session. The request endpoint gives the same answer whether or not an account exists, sends at most one email per account per minute, and ignores admin accounts. Only a SHA-256 hash of each token is stored. |
| Booking history | `GET /api/bookings?scope=history` pages through a driver's past paid bookings (completed, not used, or cancelled and refunded), newest first. `scope=upcoming` lists holds and bookings that have not ended. `GET /api/bookings/:id` returns one booking with every payment attempt and refund. The app shows these under **My bookings → Upcoming / History → Details**. |

## Pricing

```
hourly rate = BASE_HOURLY_RATE                                                    ₹30
            × (1 + TRAFFIC_PRICE_WEIGHT × congestion)                             traffic: ×1.0 … ×2.0
            × (CAPACITY_REFERENCE_SLOTS / slots in the lot) ^ CAPACITY_PRICE_ELASTICITY   lot size: 20 slots ×1.0, 6 slots ×1.52, 40 slots ×0.78
rounded to PRICE_ROUNDING (₹5), kept between MIN_HOURLY_RATE (₹10) and MAX_HOURLY_RATE (₹200)
```

- **Traffic.** Congestion is `1 − current speed / free-flow speed` on the road nearest the lot (0 = free-flowing, 1 = standing still; a closed road counts as 1). It's shown as light, moderate, heavy or severe (`TRAFFIC_LEVELS`). Without a reading the traffic factor is 1.
- **Lot size.** Fewer slots means scarcer parking, so a dearer slot. A lot of `CAPACITY_REFERENCE_SLOTS` slots pays the base rate. Set `CAPACITY_PRICE_ELASTICITY=0` to ignore lot size.
- **When it's fixed.** Prices follow the traffic now. Holding a slot fixes the amount (rate × hours), whatever time the booking is for. If traffic changed it since the driver opened the lot, the payment step says so.
- Every lot in `/api/spots` and `/api/spots/:id` carries `hourly_rate` and a `pricing` breakdown (`base_rate`, `traffic { level, congestion, multiplier, current_speed_kmh, free_flow_speed_kmh, road_closure, source, observed_at }`, `capacity { slots, multiplier }`). The app shows it on each lot.

## Live traffic

Traffic comes from the [TomTom Traffic API](https://docs.tomtom.com/traffic-api/documentation/traffic-flow/flow-segment-data) ("Flow Segment Data"), which has a free tier: sign up at [developer.tomtom.com](https://developer.tomtom.com), create a key, and set `TOMTOM_API_KEY` in `.env`. At start-up the server says whether live traffic is on.

- **Only lots people look at are fetched.** Each lot's reading is cached in the `traffic_readings` table for `TRAFFIC_CACHE_SECONDS` (10 minutes), so a lot costs at most one call per 10 minutes, and restarts don't fetch again. Concurrent requests for one lot share one call.
- **Failures don't break booking.** If TomTom is slow (`TRAFFIC_TIMEOUT_MS`), rate-limits, or rejects the key, prices keep using the last reading for up to `TRAFFIC_STALE_SECONDS` (1 hour) and then drop the traffic surcharge. The server logs the problem once and leaves TomTom alone for `TRAFFIC_RETRY_SECONDS`.
- **Other providers.** `src/services/traffic.js` defines the provider interface (`fetchFlow({ lat, lng })` → current and free-flow speed). `createApp({ traffic })` takes any provider, as tests do with fakes.

## Metro stations and demo data

`src/data/delhi-metro-stations.json` lists 203 Delhi metro stations, from [OpenStreetMap](https://www.openstreetmap.org/copyright) (© OpenStreetMap contributors, ODbL). Stations mapped once per line, such as Rajiv Chowk or "Hauz Khas (Yellow Line)", are merged. `npm run fetch-stations` downloads a fresh copy through the Overpass API. `STATIONS_AREA` (default `Delhi`), `STATIONS_AREA_ADMIN_LEVEL` and `STATIONS_FILE` choose another area or file: for another city, fetch its stations, point `STATIONS_FILE` at them, set `DEFAULT_LAT`/`DEFAULT_LNG`, and reseed.

The seed (on first start, or `npm run seed -- --reset`) puts `SEED_LOTS_PER_STATION` lots at a random bearing and `SEED_LOT_MIN_DISTANCE_M`–`SEED_LOT_MAX_DISTANCE_M` from each station, with `SEED_LOT_MIN_SLOTS`–`SEED_LOT_MAX_SLOTS` slots. "Other drivers (demo)" book `SEED_OCCUPANCY` of the slots, so lots show booked and occupied slots. The demo driver gets one upcoming booking near Connaught Place and one past one. The layout comes from `SEED_RANDOM_SEED`, so it's the same on every run.

## Booking lifecycle

```
            createHold                     pay (charge ok)              check-in at gate
  (free) ─────────────► pending_payment ─────────────────► confirmed ─────────────────► checked_in
                         │  holds slot 10 min               │ has QR pass + reference     │ slot "occupied"
                         │                                  │                             │
                         ├─ hold lapses ─► expired          ├─ cancel before start ─►     └─ window ends ─► completed
                         └─ user cancels ─► cancelled       │  cancelled + refund
                                                            └─ window ends unused ─► lapsed
```

- **Holds.** Clicking "Continue to payment" reserves the slot for 10 minutes, so nobody else can take it while the user types card details.
- **Slow-payment race.** If a hold runs out while the gateway is still processing, and someone else books the slot in that gap, the late payment is detected when it tries to confirm and is **refunded automatically**. A duplicate "pay" click is handled the same way. `test/bookings.test.js` covers this.
- `expired`, `lapsed` and `completed` depend only on the clock, so they are worked out when bookings are read, not stored.

## Check-in

1. After paying, the driver sees their **QR pass** (`GET /api/bookings/:id/qr`, an SVG served with `Cache-Control: no-store`). It stays available under **My bookings** until it is used or the booking ends, and **Save image** downloads it as a PNG with the booking details.
2. At the gate, staff open **Check-in** in the admin portal and either press **Scan with camera** or scan with a handheld scanner into the text box (these scanners type the QR's text followed by Enter). The camera scanner uses the browser's `BarcodeDetector` where it exists, and otherwise [jsQR](https://github.com/cozmo/jsQR), served by the app at `/vendor/jsQR.js`.
3. The server finds the booking by its token and checks it in if it is paid, not used and inside its window. A pass held in front of the camera is only sent once.
4. **No QR code?** (dead phone, no signal): staff find the booking under **Bookings** (by driver name, email or reference), check the driver's ID, and press **Check in manually** in its details. The same window rules apply.

Every check-in records how it happened (`qr` or `manual`) and which admin did it, shown in the booking's details.

### Scanning with a phone or tablet

Browsers only allow the camera in a secure context. `http://localhost` (and `http://127.0.0.1`) counts, so the scanner works on the computer running the server with no setup. A phone opening `http://192.168.x.x:3000/admin/` does not, and the portal says so. For other devices, turn on the HTTPS port:

```bash
HTTPS_PORT=3443 npm run dev      # or put HTTPS_PORT=3443 in .env
```

The server keeps serving HTTP on `PORT` and also serves HTTPS on `HTTPS_PORT`. At start-up it prints the address to open on a phone, e.g. `https://192.168.1.43:3443/admin/`. With no certificate of your own, it creates a self-signed one with `openssl` in `data/tls/` (next to the database), valid for `localhost`, `127.0.0.1` and this machine's network addresses. It makes a new one when the machine's address changes. Browsers warn about a self-signed certificate once: choose **Advanced → Proceed/Continue**, and then the camera works. To use a real certificate, set `TLS_CERT_FILE` and `TLS_KEY_FILE`. The admin portal opened over plain HTTP on a network address links to the HTTPS address.

When the camera doesn't start, the portal says why: the site is blocked in the browser (and how to allow it), the prompt was dismissed, the operating system is blocking the browser, there's no camera, or another app is using it. Handheld scanners work anywhere.

## Project layout

```
src/
  server.js              entry point: HTTP (and optional HTTPS) listeners, auto-seeds an empty DB
  app.js                 builds the Express app: static files, routers, error handling
  http.js                request helpers: number parsing, list paging, role guard
  routes/
    driver.js            /api: driver accounts, spots, bookings, QR pass
    admin.js             /api/admin: staff sign-in, check-in, all bookings
  tls.js                 certificates for the optional HTTPS port (self-signed via openssl)
  config.js              every setting, read and validated from the environment
  stations.js            metro station list: Overpass query, merging, loading STATIONS_FILE
  fetch-stations.js      CLI: npm run fetch-stations
  data/delhi-metro-stations.json   station snapshot from OpenStreetMap
  db.js                  schema, connection, transaction helper
  seed.js                demo data: lots near metro stations (also a CLI: npm run seed)
  create-admin.js        CLI: npm run create-admin
  services/
    availability.js      window validation, overlap/conflict checks, slot statuses
    bookings.js          hold → pay → confirm, cancel/refund, booking lists/history
    booking-records.js   booking SELECTs, derived statuses, loaders (shared by bookings and check-in)
    checkin.js           QR pass payload, check-in by scanned pass or manually
    passes.js            pass tokens, payload format, QR code SVG rendering
    spots.js             nearby search, spot detail (with prices)
    pricing.js           hourly rate from traffic and lot size
    traffic.js           traffic providers (TomTom, none), cached readings, refresh
    payments.js          mock payment gateway (charge/refund)
    mailer.js            SMTP mailer (nodemailer) or console mailer, chosen from env
    emails.js            email templates: welcome, password reset
    auth.js              accounts and roles, scrypt password hashing, sessions
    password-reset.js    reset links for driver accounts
public/                  static frontend (vanilla JS ES modules + Leaflet, no build step)
  index.html, app.js     driver app (app.js wires up the modules in driver/)
  driver/                session, modal, finder (map/search/spots), booking, pass, my-bookings, account
  admin/                 admin portal: admin.js (entry), session, checkin, scanner (camera), bookings
  common.js, styles.css  shared by both: request + API client, formatting, status badges
test/
  bookings.test.js       booking rules, history and admin search (service level)
  password-reset.test.js reset links: expiry, single use, throttling, session sign-out
  email.test.js          welcome email, SMTP delivery against a fake SMTP server, mailer failures
  portals.test.js        portal separation, QR check-in and API flows over HTTP, schema migrations
  tls.test.js            development certificate generation and serving over HTTPS
  scanner.test.js        camera error messages
  pricing.test.js        the price formula, traffic levels
  traffic.test.js        TomTom adapter against a fake TomTom, caching, failures, prices over HTTP
  seed.test.js           lots near stations, deterministic layout, no double booking, station merging
  config.test.js         settings from the environment, and validation
  support/server.js      test helpers: start the app on a random port, fake mailer, book and pay
  support/qr.js          decodes the served QR SVGs the way a scanner would
```

## API

"Driver" and "Admin" mean a Bearer token from that portal's login. A token of the wrong role gets `403`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config` | – | currency, map centre/tiles, search radius, geocoder, limits, `trafficProvider`, `httpsPort` (or `null`) |
| POST | `/api/auth/register` · `/api/auth/login` | – | driver sign-up / sign-in, returns `{ token, user }` |
| GET | `/api/auth/me` · POST `/api/auth/logout` | Driver | session |
| POST | `/api/auth/password-reset/request` `{ email }` | – | email a reset link; always `202` with the same message |
| POST | `/api/auth/password-reset/confirm` `{ token, password }` | – | set the new password, returns `{ token, user }`; a bad or expired token gives `400` with `reason: "invalid_reset_token"` |
| GET | `/api/spots?lat=&lng=&radius=` | – | nearby spots with free/total counts, `hourly_rate` and `pricing` |
| GET | `/api/spots/:id?start=&hours=` | – | slot statuses for a window, `hourly_rate` and `pricing` |
| POST | `/api/bookings` `{ slotId, startAt, hours }` | Driver | create a 10-minute hold at the lot's current price |
| POST | `/api/bookings/:id/pay` `{ card }` | Driver | charge, then confirm and issue the code |
| POST | `/api/bookings/:id/cancel` | Driver | release a hold, or cancel and refund before start |
| GET | `/api/bookings?scope=&limit=&offset=` | Driver | my bookings: `scope` is `all` (default), `upcoming` or `history` |
| GET | `/api/bookings/:id` | Driver | one of my bookings with its `payments` |
| GET | `/api/bookings/:id/qr` | Driver | the booking's QR pass as `image/svg+xml`; `409` once it is used, cancelled or over |
| POST | `/api/admin/auth/login` | – | admin sign-in, returns `{ token, user }` |
| GET | `/api/admin/auth/me` · POST `/api/admin/auth/logout` | Admin | session |
| POST | `/api/admin/checkin` `{ qr }` | Admin | check in the booking whose QR pass was scanned (`qr` is the scanned text); a booking reference gives `400` with `reason: "not_a_pass"` |
| GET | `/api/admin/bookings?q=&scope=&limit=&offset=` | Admin | all bookings; `q` matches reference, driver name or email |
| GET | `/api/admin/bookings/:id` | Admin | any booking with driver details, `payments`, and how and by whom it was checked in |
| POST | `/api/admin/bookings/:id/checkin` | Admin | manual check-in for a driver who cannot show their QR code |

Booking lists return `{ bookings, has_more, next_offset }`. `limit` defaults to 20 (max 100). Times are epoch milliseconds. Amounts are in the currency's smallest unit (e.g. paise).

## Configuration

Every setting is an environment variable with a default. `.env.example` lists them all with explanations, grouped as server, email, live traffic, pricing, map and search, booking rules, accounts, and metro stations / demo data. `npm start`, `npm run dev`, `seed`, `create-admin` and `fetch-stations` load a `.env` file if there is one (gitignored). Invalid values stop start-up with a message naming the variable, e.g. `BASE_HOURLY_RATE must be a whole number at least 0 (got "abc")`.

The ones you're most likely to change:

| Env var | Default |
|---|---|
| `PORT` | `3000` |
| `PUBLIC_URL` | `http://localhost:$PORT` (base URL for links in emails) |
| `TOMTOM_API_KEY` | unset: no live traffic, so no traffic surcharge ([details](#live-traffic)) |
| `BASE_HOURLY_RATE` | `3000` (₹30, in paise), with the rest of the [pricing](#pricing) settings |
| `SMTP_HOST` | unset: emails are printed to the console instead of sent |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `true` when `SMTP_PORT` is 465, otherwise `false` (STARTTLS is used when the server offers it) |
| `SMTP_USER`, `SMTP_PASS` | unset: no SMTP login |
| `MAIL_FROM` | required when `SMTP_HOST` is set, e.g. `ParkSlot <no-reply@example.com>` |
| `HTTPS_PORT` | unset: HTTP only. Set (e.g. `3443`) to also serve HTTPS, so the camera scanner works on phones ([details](#scanning-with-a-phone-or-tablet)) |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | unset: a self-signed certificate is generated in `tls/` next to the database (needs `openssl`) |
| `DB_FILE` | `data/parking.db` |
| `CURRENCY` | `INR` |
| `DEFAULT_LAT`, `DEFAULT_LNG` | `28.6315`, `77.2167` (Connaught Place, New Delhi) |
| `STATIONS_FILE` | `src/data/delhi-metro-stations.json` |

### Sending real email

Set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` for any SMTP provider (Amazon SES, Postmark, Mailgun, SendGrid, Gmail with an app password, …) and set `PUBLIC_URL` to the site's real address. At start-up the server says which mode it is in, and warns if it cannot reach or log in to the SMTP server. If `MAIL_FROM` is missing, the server refuses to start.

## Prototype limitations / next steps

- **Payments are mocked.** `services/payments.js` has the `charge`/`refund` interface a real adapter (Razorpay, Stripe, …) would implement. In production, card details should go to the provider's hosted checkout and never touch this server (PCI-DSS), and a payment webhook should confirm bookings.
- **Emails are sent once, in the background.** A failed send is logged but not retried. A production setup would put emails on a queue with retries, or use a provider's HTTP API with delivery webhooks.
- **Email addresses are not verified.** Anyone can sign up with any address. The welcome email tells the owner how to take the account over, but sign-up does not require confirming the address.
- **Admins cannot reset their own password.** Reset is for driver accounts only; admin accounts are managed from the CLI.
- **Parking data is seeded.** Station positions are real (OpenStreetMap), but the lots near them are invented. Real lots could come from operator onboarding or OpenStreetMap (`amenity=parking` via the Overpass API). Slot occupancy could come from gate sensors or ANPR cameras.
- **Prices use today's traffic, even for later bookings.** A booking for next week is priced at the traffic when it's made. Pricing a future window would need TomTom's historical or predictive traffic products, which aren't in the free tier.
- **Traffic is the road nearest the lot.** One road segment can misrepresent an area (a quiet side street beside a jammed arterial). Averaging several nearby points, or TomTom's area-based flow tiles, would be steadier but costs more calls.
- **Free-tier quota.** Each lot viewed costs at most one TomTom call per `TRAFFIC_CACHE_SECONDS`. Browsing many lots across Delhi can still reach the free limit; raise the cache time if it does. The server then prices without traffic until the quota resets.
- **Lot size, not occupancy.** The price depends on how many slots a lot has, not how many are free right now. Adding occupancy (surge as a lot fills) would be a small change in `pricing.js`.
- **Admins are not tied to spots.** Any admin can check in any booking and see every booking. Linking admins to the spots they staff would stop a pass being checked in at the wrong spot.
- **QR passes are static.** A screenshot of a pass works as well as the app, so a driver could pass it on. It still works only once and only within its window. A rotating, time-based QR would stop sharing but needs the app open and online at the gate.
- **No booking confirmation email.** The pass lives in the app (and as a saved image). Emailing it would help drivers who lose access to their account.
- **The demo admin has a published password.** Outside a demo, create a real admin with `npm run create-admin` and delete the demo account.
- **Only one server process should write.** SQLite with `BEGIN IMMEDIATE` is safe for this. To scale out, move to Postgres and use an exclusion constraint on `(slot_id, tstzrange(start_at, end_at))` to enforce no-overlap in the database itself.
