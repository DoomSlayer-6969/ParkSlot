# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ParkSlot is a parking slot booking prototype. Drivers find nearby parking, see each slot's status, hold a slot, pay online (mock gateway), and get a QR code pass that staff scan at the gate. There are two separate portals: the driver app at `/` (sign-up with a welcome email, password reset, booking history) and the admin portal at `/admin/` (check-in, searching all bookings). `README.md` has the full API table, the env vars and a booking lifecycle diagram. The requirements came from `Instructions.md`, which is gitignored and may be missing.

## Commands

Requires Node.js **22.13+**. The DB is the built-in `node:sqlite`, so there are no native deps. The dependencies are Express 5, nodemailer, `uqr` (QR code generation) and `jsqr` (QR decoding, served to the admin portal at `/vendor/jsQR.js`). nodemailer, uqr and jsqr are pinned to exact versions on purpose, so keep them pinned and upgrade only to releases that are a few weeks old. `npm start` and `npm run dev` load `.env` if it exists (see `.env.example`). Running `node src/server.js` directly does not load it.

```bash
npm install
npm start                      # http://localhost:3000, auto-seeds an empty DB
npm run dev                    # node --watch: restarts on every save in src/
npm test                       # node --test test/*.test.js (test/support/ holds helpers, not tests)
node --test --test-name-pattern="expired hold" test/bookings.test.js   # a single test
npm run seed -- --lat 12.97 --lng 77.59 --reset   # reseed demo data at another location
npm run create-admin -- --name "A" --email a@x.com --password 'longpass'   # sign-up never creates admins
```

The demo driver is `demo@parking.test` / `demo1234`, and the demo admin is `admin@parking.test` / `admin1234`. The demo admin is created on start-up whenever no admin exists. The test card `4242 4242 4242 4242` succeeds and `4000 0000 0000 0002` is declined. The SQLite file is `data/parking.db` (gitignored). Delete it to start fresh. A running `npm run dev` re-runs `migrate()` and the demo-admin check against this file each time it restarts, so schema changes reach the local DB as soon as they are saved. To try changes on a throwaway DB, run with `DB_FILE=/some/tmp/path.db PORT=…`.

Without `SMTP_HOST`, emails (welcome, password reset) are printed to the server console. That is the way to get a reset link locally.

The admin camera scanner works on `http://localhost` with no setup. Phones on the network need `HTTPS_PORT=3443` (a self-signed certificate is generated with `openssl` into `tls/` next to the DB, i.e. `data/tls/`), and the server prints the `https://<lan-ip>:3443/admin/` address to open.

There is no linter, formatter or frontend build step.

## Architecture

- ESM throughout (`"type": "module"`).
- `src/app.js` exports `createApp({ db, gateway, mailer, clock })`. Its dependencies are injected, so tests build the services against `openDb(':memory:')`, `createMockGateway()`, a fake mailer and a fake clock. `src/server.js` is the only place real ones are built (and the only place the HTTP and optional HTTPS listeners start). `app.js` mounts two routers, `src/routes/driver.js` at `/api` and `src/routes/admin.js` at `/api/admin`, which receive the same injected deps. Routes stay thin: they parse numbers with `number()` from `src/http.js` and call service functions in `src/services/`.
- **Services take `db` and `now` (or `clock`) explicitly.** They never call `Date.now()` themselves. Sync functions receive `now`. Async ones (`payForBooking`, `cancelBooking`) receive the `clock` function, because time moves on while they await the gateway. Keep to this so that tests can control time.
- **Two portals, separated by role.** `users.role` is `user` (driver) or `admin`. `requireRole(role)` (built by `roleGuard` in `src/http.js` and passed to both routers) sends `401` when there is no session and `403` when the session belongs to the other role. Driver routes live under `/api/*` and admin routes on the `/api/admin` router. `login(db, creds, now, role)` refuses accounts of the other role, so each portal has its own login endpoint. The frontends store their tokens under different keys (`token` and `adminToken`). New admin-only features go on the admin router and in `public/admin/`.
- Schema changes: `SCHEMA` in `db.js` is `CREATE TABLE IF NOT EXISTS`, so a new column also needs a step in `migrate()` to upgrade existing `data/parking.db` files.
- Errors: throw `HttpError(status, message, extra)` from `src/errors.js`. The Express 5 error handler turns it into `{ error, ...extra }`. Express 5 forwards rejected async handlers on its own, so no wrapper is needed.
- Units: every time is **epoch milliseconds** and every amount is in the currency's **smallest unit** (paise). The frontend `money()` divides by 100.

### Booking concurrency (the core invariant)

No double booking is enforced in application code, not by a DB constraint:

- `availability.js` holds the `BLOCKING` SQL predicate: a booking blocks its slot when it is `confirmed`/`checked_in`, or `pending_payment` with an unexpired `hold_expires_at`. `findConflict` and `slotsWithStatus` both use it. If you change what blocks a slot, change it there.
- Every check-then-write must run inside `transaction(db, fn)` from `db.js`, which uses `BEGIN IMMEDIATE` to take the write lock up front. `fn` must be synchronous. Never `await` inside a transaction.
- `payForBooking` charges the gateway *outside* the transaction. It then re-checks the status and conflicts inside a new transaction. If the hold lapsed and someone else took the slot, or a duplicate pay already confirmed it, the charge is refunded automatically.
- Stored statuses are only `pending_payment | confirmed | checked_in | cancelled`. `expired`, `lapsed` and `completed` follow from the clock and are derived on read by `effectiveStatus()` in `booking-records.js`. Never write them to the DB.
- A booking reference (`code`, `PK-XXXX-XXXX`) and a check-in token (`checkin_token`) are issued together, only after a successful payment. `code IS NOT NULL` means "paid".
- Booking lists (`listUserBookings`, `listAllBookings`) go through `pageOfBookings` with a scope from `SCOPES` (`all` / `upcoming` / `history`). Because effective statuses are derived, each scope's SQL is written against stored status plus `$now`. `history` means paid (`code IS NOT NULL`) and over, so abandoned holds are excluded. Lists return `{ bookings, has_more, next_offset }`.
- node:sqlite throws on unknown named parameters, so only bind `$now` etc. when the SQL uses them.

### QR check-in

- The driver's QR pass encodes `PARKSLOT:` + `checkin_token` (128 random bits, uppercase hex, so the payload is QR-alphanumeric and case-insensitive for handheld scanners with Caps Lock on). `passes.js` owns the token, payload format and SVG rendering. `checkin.js` owns the rules.
- The token is a credential. It is not in `BOOKING_COLUMNS` (`booking-records.js`), so it never appears in booking JSON or admin views. It only leaves the server as the SVG from `GET /api/bookings/:id/qr`, which is `no-store`. Keep it that way.
- The reference code cannot check anyone in. `POST /api/admin/checkin { qr }` takes only a scanned pass. The fallback is manual check-in (`POST /api/admin/bookings/:id/checkin`). Both go through `admit()`, inside `transaction()`, and record `checkin_method` (`qr`/`manual`) and `checked_in_by` (the admin).
- `migrate()` backfills `checkin_token` for paid bookings from before passes existed. The unique index on `checkin_token` lives in `migrate()` rather than `SCHEMA`, because `SCHEMA` runs before the column exists on old DBs.
- `public/admin/scanner.js` asks for the camera first (straight from the click), then reads it with `BarcodeDetector` when it supports `qr_code`, and otherwise loads jsQR. `getUserMedia` needs a secure context (localhost or HTTPS). On plain HTTP elsewhere, `checkin.js` doesn't call it: it shows a link to `https://<host>:<httpsPort>` (from `/api/config`). `src/tls.js` makes and reuses the self-signed development certificate (regenerated when a host is missing or it is within 30 days of expiry).

### Other pieces

- `payments.js` is a mock gateway with a `charge`/`refund` interface. It stands in for a real provider adapter.
- Email: `createApp({ mailer })` takes any object with an async `send({ to, subject, text })`. `mailer.js` has `createSmtpMailer` (nodemailer) and `createConsoleMailer`, and `createMailerFromConfig` picks SMTP when `SMTP_HOST` is set. Templates live in `emails.js`. Always send through `sendInBackground(mailer, message)`: it never awaits and never throws, so an email can't delay or fail the request that triggered it. In tests, pass a fake mailer that pushes to an outbox array. `test/email.test.js` has a fake SMTP server for checking real delivery. `server.js` builds the mailer before opening the DB: SMTP without `MAIL_FROM` stops start-up, while an unreachable SMTP server only logs a warning (from `verify()`).
- Sign-up sends a welcome email: `register(db, data, now, mailer)` sends only when it is given a mailer. Admin accounts (`createAccount`) get no email.
- Password reset (`requestPasswordReset` / `confirmPasswordReset` in `password-reset.js`, built on the account and session helpers exported by `auth.js`) is for drivers only. Tokens are stored only as SHA-256 hashes in `password_resets` and travel in the URL fragment (`/#reset=…`), which `public/driver/account.js` reads and then strips (on load and on `hashchange`). An invalid or expired token returns `400` with `reason: "invalid_reset_token"`, which the UI uses to offer a new link. The request path must not reveal whether an account exists: it sends the same response every time, and the email is sent without awaiting it. A successful reset deletes all of the user's sessions and outstanding tokens.
- `auth.js` hashes passwords with scrypt. Sessions are opaque tokens in the `sessions` table, sent as `Authorization: Bearer`. `createAccount` is the single place accounts are made: `register` uses it for drivers, and the seed and `create-admin` CLI use it for admins.
- `seed.js` uses a fixed-seed PRNG, so the demo layout is deterministic. Seeded bookings get matching `succeeded` payment rows, so receipts look real, and pass tokens from `crypto` (never the PRNG). It works both as a module (`seedDemoData`, `hasSpots`, `ensureDemoAdmin`) and as a CLI.
- `public/` is the vanilla-JS frontend (native ES modules, no bundler) served statically by Express. Shared helpers are in `common.js`: `request`, `createApiClient` (the per-portal token, Bearer header, and sign-out on 401/403), `esc`, `money`, `statusBadge`, `paymentList`, and guarded `storage`.
  - Driver app: `index.html` loads `app.js`, which wires up `public/driver/`. Modules import in one direction only, so there are no cycles: `session → modal → finder → pass → my-bookings → account → booking`. Going back up the chain uses callbacks: `initFinder({ onSlotSelected })`, `showPass(id, { onBack })`, and `onSessionChange(fn)` to redraw after login/logout. Keep new code inside that order.
  - Admin portal: `admin/admin.js` (entry: sign-in, tabs) → `checkin.js` (scan panel, uses `scanner.js`) → `bookings.js` (table, details, manual check-in) → `session.js`. `scanner.js` touches the DOM only inside functions, so `test/scanner.test.js` imports `cameraErrorMessage` in Node. `/attendant.html` redirects to `/admin/`. Leaflet comes from a CDN, and place search uses OSM Nominatim. Both frontends show and hide views with the `hidden` attribute. A global `[hidden] { display: none !important }` rule in `styles.css` keeps that working on elements that set their own `display`, so don't remove it.

## Tests

- `test/bookings.test.js` tests the services directly, including QR and manual check-in. It uses `node:test` with an in-memory DB, a fixed `T0` and an `advance(ms)` clock. Add a test there for any change to booking rules: overlap, holds, payment races, cancel/refund, check-in windows or history scopes.
- `test/password-reset.test.js` tests the reset services with a fake mailer and a controllable clock.
- `test/email.test.js` covers the welcome email, mailer failure handling, mailer selection, and SMTP delivery against a fake SMTP server.
- `test/support/server.js` has `startServer(t, { mailer, setup })` (the real app on a random port, a fresh in-memory DB, and `call()` returning decoded JSON/SVG), `fakeMailer()` and `bookAndPay()`. Use it for any HTTP-level test.
- `test/tls.test.js` generates certificates with `openssl` (skipped without it) and checks the app over HTTPS. `test/scanner.test.js` covers the camera error messages.
- `test/portals.test.js` starts the real app on a random port and calls it with `fetch`. It covers role and portal separation, QR check-in end to end (it decodes the served SVG with `test/support/qr.js`), manual check-in, password reset over HTTP, the schema migrations, and request parsing. Add tests there for route-level or auth behaviour.
