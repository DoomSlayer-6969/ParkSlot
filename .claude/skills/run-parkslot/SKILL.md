---
name: run-parkslot
description: Run, start, drive and screenshot ParkSlot (driver app and admin portal) in a headless browser, or smoke-test its API. Use when asked to run ParkSlot, launch the server, click through booking/payment/QR pass/check-in flows, take a screenshot of the UI, verify a frontend or API change in the real app, or run its tests.
---

ParkSlot is an Express server that serves two vanilla-JS frontends: the driver app at `/` and the admin portal at `/admin/`. Agents drive it with **`.claude/skills/run-parkslot/stack.sh`**, which starts a throwaway server and a headless Firefox, and **`.claude/skills/run-parkslot/driver.mjs`**, which runs a script of commands from stdin against that Firefox over WebDriver BiDi. Nothing needs installing: no Playwright, no chromium-cli, no geckodriver.

All paths are relative to the ParkSlot directory (the one with `package.json`). Run every command from there.

## Prerequisites

- Node.js 22.13+ (tested with 26.13.1). `node:sqlite` and the global `WebSocket` are built in.
- Firefox with WebDriver BiDi (tested with Firefox 158, already installed on the machine; nothing was installed).

## Setup

```bash
npm install
```

## Run (agent path)

```bash
.claude/skills/run-parkslot/stack.sh up      # server :3123 on a fresh DB + headless Firefox (BiDi :9333)
```

`up` always starts clean: it wipes `${TMPDIR:-/tmp}/parkslot-run/` (DB, logs, screenshots, Firefox profile) and re-seeds the demo data: a parking lot near each of the ~200 Delhi metro stations in `src/data/delhi-metro-stations.json`, about 40% of slots booked by "Other drivers (demo)". Add `FAKE_TRAFFIC=1` to price lots from a local stand-in for TomTom's traffic API (`fake-tomtom.mjs`: congestion varies by location, one call per lot per 10 minutes, log in the run dir); without it there's no traffic data, and prices depend on lot size only. The demo driver is `demo@parking.test` / `demo1234` and the demo admin is `admin@parking.test` / `admin1234`. The test card `4242 4242 4242 4242` succeeds.

**End-to-end flow: book, pay, read the QR pass, check it in at the admin portal.** It is verified, so copy it and edit the middle:

```bash
node .claude/skills/run-parkslot/driver.mjs <<'EOF'
# Driver app: log in, book a free slot, pay, read the QR pass
nav /
click #login-btn
fill #auth-form>label>[name=email] demo@parking.test
fill #auth-form>label>[name=password] demo1234
submit #auth-form
wait-for #bookings-btn
click .badge.ok
click .slot.free
click #book-confirm
wait-for #pay-form
fill #pay-form>label>[name=name] Demo
fill #pay-form>label>[name=number] 4242 4242 4242 4242
fill #pay-form>.row>label>[name=expiry] 12/49
fill #pay-form>.row>label>[name=cvc] 123
submit #pay-form
wait-for .qr-pass>img
decode-qr .qr-pass>img
screenshot driver-pass
# Admin portal: sign in and "scan" that pass with the handheld-scanner input
nav /admin/
fill #login-form>label>[name=email] admin@parking.test
fill #login-form>label>[name=password] admin1234
submit #login-form
wait-for #checkin-form
fill #checkin-form>label>.scan-row>[name=qr] $QR
submit #checkin-form
wait-for .result.ok
text #checkin-result
screenshot admin-checked-in
EOF
```

**Admin manual check-in** (for a driver with no QR code). Find a paid booking whose window has started, search for its reference, and check it in from the booking details. It starts with `up` because the previous flow left the admin logged in:

```bash
.claude/skills/run-parkslot/stack.sh up
node .claude/skills/run-parkslot/driver.mjs <<'EOF'
nav /admin/
fill #login-form>label>[name=email] admin@parking.test
fill #login-form>label>[name=password] admin1234
submit #login-form
wait-for #checkin-form
set REF (async () => { for (let offset = 0; offset !== null;) { const page = await (await fetch(`/api/admin/bookings?scope=upcoming&limit=100&offset=${offset}`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('adminToken') } })).json(); const hit = page.bookings.find((b) => b.status === 'confirmed' && b.start_at <= Date.now()); if (hit) return hit.code; offset = page.next_offset; } })()
click [data-panel=bookings]
fill #booking-search>[name=q] $REF
submit #booking-search
wait-js document.querySelectorAll('#bookings-body tr').length === 1
click [data-booking]
confirm-yes
click #manual-checkin
wait-js /manually by/.test(document.querySelector('#modal-body').textContent)
screenshot manual-checkin
EOF
```

**Traffic-based prices** (fake traffic feed): the price breakdown of a lot near Connaught Place:

```bash
FAKE_TRAFFIC=1 .claude/skills/run-parkslot/stack.sh up
node .claude/skills/run-parkslot/driver.mjs <<'EOF'
nav /
wait-for .spot-item
screenshot spot-list
click .spot-list>li:nth-child(5)>.spot-item
wait-for .price-box
text .price-box
screenshot spot-detail
EOF
```

Expected: list items show `₹…/h` with a traffic chip, and the breakdown reads "Base rate ₹30.00 / Severe traffic: 16 km/h where traffic usually does 60 ×1.73 / Lot size: 12 slots ×1.20" (₹60.00 per hour, with the TomTom attribution). `curl -s "localhost:3123/api/spots?lat=28.6315&lng=77.2167"` returns the same `pricing` objects.

**Camera scanner and HTTPS.** `FAKE_CAMERA=1` gives Firefox a synthetic camera with no permission prompt. `HTTPS_PORT` makes the server also serve HTTPS with a self-signed certificate (created in the run dir), and `ACCEPT_INSECURE_CERTS=1` lets the driver open it. This checks the camera on localhost, the "use HTTPS" hint on the plain-HTTP network address, and the camera over HTTPS on that address (replace `192.168.1.43` with this machine's address from `ip -4 addr`; the server log lists it):

```bash
FAKE_CAMERA=1 HTTPS_PORT=3444 .claude/skills/run-parkslot/stack.sh up
for url in http://localhost:3123/admin/ http://192.168.1.43:3123/admin/ https://192.168.1.43:3444/admin/; do
ACCEPT_INSECURE_CERTS=1 node .claude/skills/run-parkslot/driver.mjs <<EOF
nav $url
fill #login-form>label>[name=email] admin@parking.test
fill #login-form>label>[name=password] admin1234
submit #login-form
wait-for #camera-btn
click #camera-btn
sleep 2500
eval ({ secure: window.isSecureContext, status: document.querySelector('#scanner-status').innerText, video: document.querySelector('#scanner-video').videoWidth })
screenshot camera
EOF
done
```

Expected: localhost and the HTTPS address show `video: 640` and "Hold the QR code inside the frame." The plain-HTTP network address shows `secure: false` and a link to the HTTPS portal. The fake feed is a plain colour, so it never contains a QR code: test decoding with `decode-qr` plus the handheld input, as in the first flow.

Each command prints `> line`. Screenshots print their path and land in `${TMPDIR:-/tmp}/parkslot-run/shots/NN-<name>.png` (numbering continues across driver runs), so **open them with Read and look**. On the first failure the driver prints `FAILED: …`, saves `NN-error.png` and exits 1. At the end it prints any `[error]` console messages.

| command | what it does |
|---|---|
| `nav <path-or-url>` | navigate and wait for load (`/admin/` resolves against `http://localhost:3123`) |
| `wait-for <selector>` | wait until the element exists **and is rendered** (not in a `hidden` view) |
| `wait-js <expression>` | wait until a JS expression is truthy |
| `click <selector>` | wait for it, scroll to it, `el.click()` |
| `fill <selector> <value>` | set `.value` and fire `input`/`change`. **The selector must not contain spaces**; the value is the rest of the line |
| `submit <form-selector>` | `form.requestSubmit()` (runs the app's submit handler, same as pressing Enter) |
| `text <selector>` | print `innerText` |
| `eval <expression>` | print the JSON of a JS expression (promises are awaited) |
| `set <NAME> <expression>` | evaluate and store the result as `$NAME` for later lines (fails if it is null) |
| `confirm-yes` | make `window.confirm()` return true (headless can't click dialogs) |
| `decode-qr <img-selector>` | read a QR code on the page with the app's own `/vendor/jsQR.js` and store it as `$QR` |
| `viewport <w> <h>` | resize (e.g. `viewport 390 844` for a phone) |
| `screenshot [name]` | save a PNG of the viewport |
| `sleep <ms>` · `console` | pause · print captured console output |

`$QR`, and any `$NAME` from `set`, is substituted into later lines. Lines starting with `#` are comments.

### API only (no browser)

For backend-only changes, `curl` the server that `stack.sh up` started (it must still be up):

```bash
curl -s localhost:3123/api/config
TOKEN=$(curl -s -X POST localhost:3123/api/admin/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@parking.test","password":"admin1234"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s "localhost:3123/api/admin/bookings?scope=upcoming&limit=1" -H "Authorization: Bearer $TOKEN"
```

To get a QR pass payload you can POST to `/api/admin/checkin` as `{ "qr": "<payload>" }` without going through the browser, read the token from the throwaway DB:

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
console.log(db.prepare(\"SELECT 'PARKSLOT:' || checkin_token AS qr FROM bookings WHERE status = 'confirmed' AND start_at <= ?1 AND end_at > ?1 LIMIT 1\").get(Date.now()).qr);
" "${TMPDIR:-/tmp}/parkslot-run/parking.db"
```

Stop when done (the DB file stays until the next `up`):

```bash
.claude/skills/run-parkslot/stack.sh down
```

## Run (human path)

```bash
npm run dev     # http://localhost:3000 on data/parking.db, restarts on save. Ctrl-C to stop.
```

## Test

```bash
npm test        # 68 tests: services, pricing, traffic, seed, config, HTTP portals, email, password reset, migrations, HTTPS, camera
```

## Gotchas

- **Stay off ports 3000 and 3443, and `data/parking.db`.** The user's `npm run dev` uses 3000, and 3443 for HTTPS (`HTTPS_PORT` in their `.env`), so the skill's HTTPS runs use 3444; `stack.sh up` refuses a busy `HTTPS_PORT`. `node --watch` restarts the user's server and re-runs `migrate()` against `data/parking.db` on every save. After big edits, check that it still answers: `curl -s localhost:3000/api/config`. `stack.sh` uses port 3123 and its own DB, and its `down` only kills what is listening on 3123 (and 4555, the fake traffic feed) plus the Firefox running with its own profile.
- **`stack.sh up` wipes the previous run**, screenshots included. Read or copy the screenshots before running `up` again.
- **Login persists across driver runs.** Each `up` makes a fresh Firefox profile, but within one `up` the app's `localStorage` token survives, so a second `nav /` lands already logged in and `#login-btn` doesn't exist. Run `up` again, or `click #logout-btn` first. The same applies to `adminToken` in the admin portal.
- **One BiDi session at a time.** The driver ends its session even on failure. If a driver process is killed mid-run, the next one fails with `session not created: Maximum number of active sessions`, and `stack.sh up` fixes it.
- **Selectors can't contain spaces** (`fill` splits on the first space). Use child combinators: `#pay-form>.row>label>[name=cvc]`.
- **Pick a spot with space.** The first spot in the list can be full, and every run books more slots. `click .badge.ok` opens the nearest spot that has a free slot.
- **The demo driver starts with two bookings**: an upcoming one near Connaught Place (with a QR pass) and a used one in History. Every other seeded booking belongs to "Other drivers (demo)", so the admin portal shows plenty, but the driver's My bookings stays short.
- **Seeded references are not stable across seed changes.** Don't hard-code `PK-DEMO-…` codes; look one up with `set` and the admin API (as in the manual check-in flow).
- **Prices change when traffic does.** A lot's reading is cached 10 minutes (`TRAFFIC_CACHE_SECONDS`), so within one run prices are stable. To see the "price changed" notice in the payment step, open a lot, then edit its row in `traffic_readings` in the run dir's `parking.db` (with a fresh `fetched_at`) before clicking Book.
- **Headless has no camera** unless you use `FAKE_CAMERA=1`. Without it, **Scan with camera** reports "The camera was not allowed…". To test a specific camera failure message, stub it first: `eval navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', 'NotReadableError'))`. Firefox has no `BarcodeDetector`, so this exercises the jsQR fallback. Chrome's native path can't be tested here.
- **Headless reports `(pointer: fine)` as false**, so the admin portal does not auto-focus the scanner input (deliberate on touch devices). Use `fill`, and don't assert on focus.
- **Lists are paged (20 rows).** A booking you're looking for in the admin **Bookings** table may not be on the first page. Search for its reference (`fill #booking-search>[name=q] PK-…`), or `eval` a `fetch('/api/admin/bookings?…', { headers: { Authorization: 'Bearer ' + localStorage.getItem('adminToken') } })` to find IDs and epoch-ms times.
- **Never `pkill -f` a pattern that appears in your own command line** (such as a script name you're also running). It kills the agent's own shell (exit 144). `stack.sh down` matches only Firefox's `--profile <run dir>` argument and the port-3123 listener.
- **Console noise from outside the app** (web fonts and the like) means a non-ParkSlot page loaded. `stack.sh` starts Firefox on `about:blank` because Fedora's start page in the first tab used to log `Hydration completed but contains mismatches`.

## Troubleshooting

- **`cannot reach Firefox on port 9333: run stack.sh up first`**: the stack isn't running, or Firefox exited. Check `${TMPDIR:-/tmp}/parkslot-run/firefox.log`, then run `up` again.
- **`timed out after 10000 ms waiting for #login-btn`**: you're already logged in (see Gotchas).
- **`timed out … waiting for .slot.free`**: the spot you opened is full. Use `click .badge.ok`.
- **`server did not start:`** from `stack.sh up`: it prints `server.log`. Usually `npm install` hasn't been run.
- Slow step? Set `WAIT_MS=20000` before `node …/driver.mjs` (the default is 10 s per wait).
