# ParkSlot: parking slot booking prototype

Find parking near where you're going, see every slot's live status, book a slot for _n_ hours, pay online, and get a booking ID to show on arrival. Built from the requirements in [Instructions.md](Instructions.md).

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
| Demo login | `demo@parking.test` / `demo1234` |
| Test card (success) | `4242 4242 4242 4242`, any future expiry, any CVC |
| Test card (declined) | `4000 0000 0000 0002` |
| Attendant check-in | http://localhost:3000/attendant.html, key `demo-attendant` |

To seed somewhere else: `npm run seed -- --lat 12.9716 --lng 77.5946 --reset`, and set `DEFAULT_LAT` / `DEFAULT_LNG` so the map opens there.

## How the requirements are met

| Requirement | Implementation |
|---|---|
| Nearby parking around a chosen location | Search a place (OpenStreetMap Nominatim), use your location, or click the map. `GET /api/spots?lat&lng&radius` returns spots within 3 km, nearest first (bounding box in SQL, then haversine). |
| Every slot's status in a spot | `GET /api/spots/:id?start&hours` returns each slot as **free**, **booked** (paid or mid-checkout), or **occupied** (driver checked in) for the chosen window, plus its upcoming booked times. |
| Book for _n_ hours, charged hourly | Choose an arrival time (up to 7 days ahead) and 1–24 whole hours. Price = `hourly_rate × hours`. |
| No double booking | Checking for an overlapping booking and inserting the new one happen in a single `BEGIN IMMEDIATE` SQLite transaction, so two requests cannot both pass the check. See [Booking lifecycle](#booking-lifecycle). |
| Unique booking ID, arrive any time in the window | On successful payment the booking gets a random code such as `PK-7F3K-9QX2` (unique in the DB; letters/digits that look alike are left out). The attendant check-in accepts it any time in `[start, end)`, once. |
| Online payment only | No cash or pay-later path exists. A booking is only confirmed, and only gets its ID, after an online charge succeeds. |

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
  services/
    availability.js      window validation, overlap/conflict checks, slot statuses
    bookings.js          hold → pay → confirm, cancel/refund, check-in
    spots.js             nearby search, spot detail
    payments.js          mock payment gateway (charge/refund)
    auth.js              register/login, scrypt password hashing, sessions
public/                  static frontend (vanilla JS + Leaflet, no build step)
  index.html, app.js     driver app
  attendant.html/.js     gate check-in screen
test/bookings.test.js    node:test suite for the booking rules
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config` | – | currency, default map centre, limits |
| POST | `/api/auth/register` · `/api/auth/login` | – | returns `{ token, user }` |
| GET | `/api/auth/me` · POST `/api/auth/logout` | Bearer | session |
| GET | `/api/spots?lat=&lng=&radius=` | – | nearby spots with free/total counts |
| GET | `/api/spots/:id?start=&hours=` | – | slot statuses for a window |
| POST | `/api/bookings` `{ slotId, startAt, hours }` | Bearer | create a 10-minute hold |
| POST | `/api/bookings/:id/pay` `{ card }` | Bearer | charge, then confirm and issue the code |
| POST | `/api/bookings/:id/cancel` | Bearer | release a hold, or cancel and refund before start |
| GET | `/api/bookings` | Bearer | my bookings |
| POST | `/api/checkin` `{ code }` | `x-attendant-key` | validate the code at arrival |

Times are epoch milliseconds. Amounts are in the currency's smallest unit (e.g. paise).

## Configuration

| Env var | Default |
|---|---|
| `PORT` | `3000` |
| `DB_FILE` | `data/parking.db` |
| `CURRENCY` | `INR` |
| `DEFAULT_LAT`, `DEFAULT_LNG` | `28.6315`, `77.2167` (New Delhi) |
| `ATTENDANT_KEY` | `demo-attendant` |

## Prototype limitations / next steps

- **Payments are mocked.** `services/payments.js` has the `charge`/`refund` interface a real adapter (Razorpay, Stripe, …) would implement. In production, card details should go to the provider's hosted checkout and never touch this server (PCI-DSS), and a payment webhook should confirm bookings.
- **Parking data is seeded.** Real spots could come from operator onboarding or OpenStreetMap (`amenity=parking` via the Overpass API). Slot occupancy could come from gate sensors or ANPR cameras.
- **Attendants share one key.** Replace it with staff accounts tied to specific spots, so a code can only be checked in at its own spot.
- **Only one server process should write.** SQLite with `BEGIN IMMEDIATE` is safe for this. To scale out, move to Postgres and use an exclusion constraint on `(slot_id, tstzrange(start_at, end_at))` to enforce no-overlap in the database itself.
