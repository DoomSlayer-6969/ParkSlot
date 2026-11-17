# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ParkSlot is a parking slot booking prototype. Drivers find nearby parking, see each slot's status, hold a slot, pay online (mock gateway), and get a booking code that staff check in at the gate. There are two separate portals: the driver app at `/` and the admin portal at `/admin/`. `README.md` has the full API table, the env vars and a booking lifecycle diagram. The requirements came from `Instructions.md`, which is gitignored and may be missing.

## Commands

Requires Node.js **22.13+**. The DB is the built-in `node:sqlite`, so there are no native deps. The only dependency is Express 5.

```bash
npm install
npm start                      # http://localhost:3000, auto-seeds an empty DB
npm run dev                    # node --watch
npm test                       # node --test (runs test/*.test.js)
node --test --test-name-pattern="expired hold" test/bookings.test.js   # a single test
npm run seed -- --lat 12.97 --lng 77.59 --reset   # reseed demo data at another location
npm run create-admin -- --name "A" --email a@x.com --password 'longpass'   # sign-up never creates admins
```

The demo driver is `demo@parking.test` / `demo1234`, and the demo admin is `admin@parking.test` / `admin1234`. The demo admin is created on start-up whenever no admin exists. The test card `4242 4242 4242 4242` succeeds and `4000 0000 0000 0002` is declined. The SQLite file is `data/parking.db` (gitignored). Delete it to start fresh.

There is no linter, formatter or frontend build step.

## Architecture

- ESM throughout (`"type": "module"`).
- `src/app.js` exports `createApp({ db, gateway, clock })`. Its dependencies are injected, so tests build the services against `openDb(':memory:')`, `createMockGateway()` and a fake clock. Routes stay thin: they parse numbers with `number()` and call service functions in `src/services/`.
- **Services take `db` and `now` (or `clock`) explicitly.** They never call `Date.now()` themselves. Sync functions receive `now`. Async ones (`payForBooking`, `cancelBooking`) receive the `clock` function, because time moves on while they await the gateway. Keep to this so that tests can control time.
- **Two portals, separated by role.** `users.role` is `user` (driver) or `admin`. `requireRole(role)` in `app.js` sends `401` when there is no session and `403` when the session belongs to the other role. Driver routes live under `/api/*` and admin routes on the `/api/admin` router. `login(db, creds, now, role)` refuses accounts of the other role, so each portal has its own login endpoint. The frontends store their tokens under different keys (`token` and `adminToken`). New admin-only features go on the admin router and in `public/admin/`.
- Schema changes: `SCHEMA` in `db.js` is `CREATE TABLE IF NOT EXISTS`, so a new column also needs a step in `migrate()` to upgrade existing `data/parking.db` files.
- Errors: throw `HttpError(status, message, extra)` from `src/errors.js`. The Express 5 error handler turns it into `{ error, ...extra }`. Express 5 forwards rejected async handlers on its own, so no wrapper is needed.
- Units: every time is **epoch milliseconds** and every amount is in the currency's **smallest unit** (paise). The frontend `money()` divides by 100.

### Booking concurrency (the core invariant)

No double booking is enforced in application code, not by a DB constraint:

- `availability.js` holds the `BLOCKING` SQL predicate: a booking blocks its slot when it is `confirmed`/`checked_in`, or `pending_payment` with an unexpired `hold_expires_at`. `findConflict` and `slotsWithStatus` both use it. If you change what blocks a slot, change it there.
- Every check-then-write must run inside `transaction(db, fn)` from `db.js`, which uses `BEGIN IMMEDIATE` to take the write lock up front. `fn` must be synchronous. Never `await` inside a transaction.
- `payForBooking` charges the gateway *outside* the transaction. It then re-checks the status and conflicts inside a new transaction. If the hold lapsed and someone else took the slot, or a duplicate pay already confirmed it, the charge is refunded automatically.
- Stored statuses are only `pending_payment | confirmed | checked_in | cancelled`. `expired`, `lapsed` and `completed` follow from the clock and are derived on read by `effectiveStatus()` in `bookings.js`. Never write them to the DB.
- A booking code (`PK-XXXX-XXXX`) is issued only after a successful payment.
- Booking lists (`listUserBookings`, `listAllBookings`) go through `pageOfBookings` with a scope from `SCOPES` (`all` / `upcoming` / `history`). Because effective statuses are derived, each scope's SQL is written against stored status plus `$now`. `history` means paid (`code IS NOT NULL`) and over, so abandoned holds are excluded. Lists return `{ bookings, has_more, next_offset }`.
- node:sqlite throws on unknown named parameters, so only bind `$now` etc. when the SQL uses them.

### Other pieces

- `payments.js` is a mock gateway with a `charge`/`refund` interface. It stands in for a real provider adapter. `mailer.js` works the same way for email: `createConsoleMailer()` prints messages, and `createApp({ mailer })` takes any object with an async `send({ to, subject, text })`. In tests, pass a fake mailer that pushes to an outbox array.
- Password reset (`requestPasswordReset` / `confirmPasswordReset` in `auth.js`) is for drivers only. Tokens are stored only as SHA-256 hashes in `password_resets` and travel in the URL fragment (`/#reset=…`), which `app.js` reads and then strips. The request path must not reveal whether an account exists: it sends the same response every time, and the email is sent without awaiting it. A successful reset deletes all of the user's sessions and outstanding tokens.
- `auth.js` hashes passwords with scrypt. Sessions are opaque tokens in the `sessions` table, sent as `Authorization: Bearer`. `createAccount` is the single place accounts are made: `register` uses it for drivers, and the seed and `create-admin` CLI use it for admins.
- `seed.js` uses a fixed-seed PRNG, so the demo layout is deterministic. It works both as a module (`seedDemoData`, `hasSpots`) and as a CLI.
- `public/` is the vanilla-JS frontend served statically by Express: the driver app (`index.html`/`app.js`), the admin portal (`admin/`), and shared helpers in `common.js` (`request`, `esc`, `money`, `paymentList`, guarded `storage`). `/attendant.html` redirects to `/admin/`. Leaflet comes from a CDN, and place search uses OSM Nominatim.

## Tests

- `test/bookings.test.js` tests the services directly. It uses `node:test` with an in-memory DB, a fixed `T0` and an `advance(ms)` clock. Add a test there for any change to booking rules: overlap, holds, payment races, cancel/refund, check-in windows or history scopes.
- `test/password-reset.test.js` tests the reset services with a fake mailer and a controllable clock.
- `test/portals.test.js` starts the real app on a random port and calls it with `fetch`. It covers role and portal separation, the schema migration, and request parsing. Add tests there for route-level or auth behaviour.
