import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createAccount } from '../src/services/auth.js';
import { createMockGateway, TEST_CARDS } from '../src/services/payments.js';
import { decodeQrSvg } from './support/qr.js';

const ADMIN = { name: 'Admin', email: 'admin@test.dev', password: 'password1' };
const DRIVER = { name: 'Driver', email: 'driver@test.dev', password: 'password1' };

async function bookAndPay(call, token) {
  const hold = (await call('/api/bookings', { token, method: 'POST', body: { slotId: 1, startAt: Date.now(), hours: 1 } })).body;
  const card = { name: 'D', number: TEST_CARDS.success, expiry: '12/49', cvc: '123' };
  return (await call(`/api/bookings/${hold.id}/pay`, { token, method: 'POST', body: { card } })).body;
}

/** Runs the real HTTP app on a random port against an in-memory DB. */
async function startServer(t) {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO parking_spots (id, name, address, lat, lng, hourly_rate) VALUES (1, 'Lot', '1 Test Rd', 10, 20, 5000);
    INSERT INTO slots (id, spot_id, label) VALUES (1, 1, 'A1');
  `);
  createAccount(db, { ...ADMIN, role: 'admin' }, Date.now());

  const outbox = [];
  const mailer = { send: async (message) => { outbox.push(message); } };
  const server = createApp({ db, gateway: createMockGateway(), mailer }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { token, method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('application/json') ? await res.json() : type.includes('svg') ? await res.text() : null;
    return { status: res.status, headers: res.headers, body: data };
  };
  return { db, call, outbox };
}

test('drivers and admins sign in to separate portals, and each session works only in its own', async (t) => {
  const { call } = await startServer(t);
  const driver = (await call('/api/auth/register', { method: 'POST', body: DRIVER })).body;
  assert.equal(driver.user.role, 'user');

  assert.equal((await call('/api/admin/auth/login', { method: 'POST', body: DRIVER })).status, 403);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: ADMIN })).status, 403);
  const admin = await call('/api/admin/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.user.role, 'admin');
  const adminToken = admin.body.token;

  // Wrong portal → 403, no session → 401.
  assert.equal((await call('/api/admin/bookings', { token: driver.token })).status, 403);
  assert.equal((await call('/api/admin/auth/me', { token: driver.token })).status, 403);
  assert.equal((await call('/api/bookings', { token: adminToken })).status, 403);
  assert.equal((await call('/api/auth/me', { token: adminToken })).status, 403);
  assert.equal((await call('/api/bookings', { token: adminToken, method: 'POST', body: { slotId: 1, startAt: Date.now(), hours: 1 } })).status, 403);
  assert.equal((await call('/api/admin/bookings')).status, 401);

  assert.equal((await call('/api/admin/auth/me', { token: adminToken })).body.user.email, ADMIN.email);
  assert.equal((await call('/api/admin/auth/logout', { token: adminToken, method: 'POST' })).status, 204);
  assert.equal((await call('/api/admin/auth/me', { token: adminToken })).status, 401);
});

test('signing up never creates an admin', async (t) => {
  const { call } = await startServer(t);
  const res = await call('/api/auth/register', { method: 'POST', body: { ...DRIVER, role: 'admin' } });
  assert.equal(res.body.user.role, 'user');
  assert.equal((await call('/api/admin/auth/login', { method: 'POST', body: DRIVER })).status, 403);
});

test('a driver fetches their booking history and receipt; an admin checks them in', async (t) => {
  const { call } = await startServer(t);
  const { token } = (await call('/api/auth/register', { method: 'POST', body: DRIVER })).body;
  const adminToken = (await call('/api/admin/auth/login', { method: 'POST', body: ADMIN })).body.token;
  const booking = await bookAndPay(call, token);

  const upcoming = (await call('/api/bookings?scope=upcoming', { token })).body;
  assert.deepEqual(upcoming.bookings.map((b) => b.id), [booking.id]);
  assert.equal(upcoming.has_more, false);
  assert.deepEqual((await call('/api/bookings?scope=history', { token })).body.bookings, []);
  assert.equal((await call('/api/bookings?scope=bogus', { token })).status, 400);
  assert.equal((await call('/api/bookings?limit=abc', { token })).status, 400);

  const receipt = (await call(`/api/bookings/${booking.id}`, { token })).body;
  assert.deepEqual(receipt.payments.map((p) => p.status), ['succeeded']);

  // Check-in is admin-only; the old shared-key endpoint and page are gone.
  assert.equal((await call('/api/checkin', { method: 'POST', body: { code: booking.code } })).status, 404);
  const legacyPage = await call('/attendant.html');
  assert.equal(legacyPage.status, 301);
  assert.equal(legacyPage.headers.get('location'), '/admin/');

  const seen = (await call(`/api/admin/bookings?q=${encodeURIComponent(DRIVER.email)}`, { token: adminToken })).body;
  assert.deepEqual(seen.bookings.map((b) => [b.id, b.user_email, b.status]), [[booking.id, DRIVER.email, 'confirmed']]);
  assert.equal((await call(`/api/admin/bookings/${booking.id}`, { token: adminToken })).body.user_name, DRIVER.name);
});

test('the QR pass the driver is shown checks them in when an admin scans it', async (t) => {
  const { call } = await startServer(t);
  const { token } = (await call('/api/auth/register', { method: 'POST', body: DRIVER })).body;
  const other = (await call('/api/auth/register', { method: 'POST', body: { ...DRIVER, email: 'other@test.dev' } })).body.token;
  const adminToken = (await call('/api/admin/auth/login', { method: 'POST', body: ADMIN })).body.token;
  const booking = await bookAndPay(call, token);

  const qr = await call(`/api/bookings/${booking.id}/qr`, { token });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(qr.headers.get('cache-control'), 'no-store');
  const scanned = decodeQrSvg(qr.body);
  assert.match(scanned, /^PARKSLOT:[0-9A-F]{32}$/);
  assert.equal((await call(`/api/bookings/${booking.id}/qr`, { token: other })).status, 404);
  assert.equal((await call(`/api/bookings/${booking.id}/qr`, { token: adminToken })).status, 403);
  assert.equal((await call(`/api/bookings/${booking.id}/qr`)).status, 401);

  const checkIn = (body, as = adminToken) => call('/api/admin/checkin', { token: as, method: 'POST', body });
  assert.equal((await checkIn({ qr: scanned }, token)).status, 403); // drivers cannot check themselves in
  const typedCode = await checkIn({ code: booking.code });
  assert.equal(typedCode.status, 400);
  assert.equal((await checkIn({ qr: booking.code })).body.reason, 'not_a_pass');

  const checkedIn = await checkIn({ qr: scanned });
  assert.equal(checkedIn.status, 200);
  assert.deepEqual([checkedIn.body.status, checkedIn.body.checkin_method, checkedIn.body.checked_in_by_name],
    ['checked_in', 'qr', ADMIN.name]);
  assert.equal((await checkIn({ qr: scanned })).status, 409);
  assert.equal((await call(`/api/bookings/${booking.id}/qr`, { token })).status, 409); // used passes are not shown
});

test('an admin can check a booking in manually when the driver has no QR code', async (t) => {
  const { call } = await startServer(t);
  const { token } = (await call('/api/auth/register', { method: 'POST', body: DRIVER })).body;
  const adminToken = (await call('/api/admin/auth/login', { method: 'POST', body: ADMIN })).body.token;
  const booking = await bookAndPay(call, token);

  const manual = (id, as = adminToken) => call(`/api/admin/bookings/${id}/checkin`, { token: as, method: 'POST' });
  assert.equal((await manual(booking.id, token)).status, 403);
  assert.equal((await manual(9999)).status, 404);
  assert.equal((await manual('abc')).status, 400);
  const res = await manual(booking.id);
  assert.deepEqual([res.status, res.body.checkin_method], [200, 'manual']);
  const detail = (await call(`/api/admin/bookings/${booking.id}`, { token: adminToken })).body;
  assert.deepEqual([detail.status, detail.checked_in_by_name], ['checked_in', ADMIN.name]);
});

test('password reset over HTTP: same answer for any email, and the link signs the driver in', async (t) => {
  const { call, outbox } = await startServer(t);
  const { token: oldSession } = (await call('/api/auth/register', { method: 'POST', body: DRIVER })).body;
  const ask = (email) => call('/api/auth/password-reset/request', { method: 'POST', body: { email } });

  const known = await ask(DRIVER.email);
  const unknown = await ask('nobody@test.dev');
  const admin = await ask(ADMIN.email);
  assert.equal(known.status, 202);
  assert.deepEqual([unknown.status, unknown.body], [known.status, known.body]);
  assert.deepEqual([admin.status, admin.body], [known.status, known.body]);
  const resets = outbox.filter((m) => m.subject === 'Reset your ParkSlot password');
  assert.equal(resets.length, 1);
  assert.equal((await ask('')).status, 400);

  const resetToken = /#reset=([\w-]+)/.exec(resets[0].text)[1];
  const confirm = (body) => call('/api/auth/password-reset/confirm', { method: 'POST', body });
  const tooShort = await confirm({ token: resetToken, password: 'short' });
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.body.reason, undefined);
  assert.equal((await confirm({ token: 'made-up', password: 'brand-new-pass' })).body.reason, 'invalid_reset_token');
  const done = await confirm({ token: resetToken, password: 'brand-new-pass' });
  assert.equal(done.status, 200);
  assert.equal((await call('/api/auth/me', { token: done.body.token })).body.user.email, DRIVER.email);
  assert.equal((await call('/api/auth/me', { token: oldSession })).status, 401);
  assert.equal((await confirm({ token: resetToken, password: 'brand-new-pass' })).status, 400);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { ...DRIVER, password: 'brand-new-pass' } })).status, 200);
  assert.equal((await call('/api/config')).body.resetTokenMinutes, 30);
});

test('opening a database from before roles existed adds the role column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parkslot-'));
  try {
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
                          password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users (name, email, password_hash, created_at) VALUES ('Old', 'old@test.dev', 'x:y', 0);
    `);
    old.close();

    const db = openDb(file);
    assert.equal(db.prepare('SELECT role FROM users').get().role, 'user');
    openDb(file).close(); // migrating twice is a no-op
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a database from before QR passes adds the check-in columns and issues passes to paid bookings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parkslot-'));
  try {
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
                          password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
      CREATE TABLE parking_spots (id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
                                  lat REAL NOT NULL, lng REAL NOT NULL, hourly_rate INTEGER NOT NULL);
      CREATE TABLE slots (id INTEGER PRIMARY KEY, spot_id INTEGER NOT NULL, label TEXT NOT NULL);
      CREATE TABLE bookings (id INTEGER PRIMARY KEY, code TEXT UNIQUE, slot_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, hours INTEGER NOT NULL, amount INTEGER NOT NULL,
        status TEXT NOT NULL, hold_expires_at INTEGER, checked_in_at INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO users (id, name, email, password_hash, created_at) VALUES (1, 'Old', 'old@test.dev', 'x:y', 0);
      INSERT INTO parking_spots VALUES (1, 'Lot', 'Rd', 0, 0, 100);
      INSERT INTO slots VALUES (1, 1, 'A1');
      INSERT INTO bookings (id, code, slot_id, user_id, start_at, end_at, hours, amount, status, created_at) VALUES
        (1, 'PK-AAAA-AAAA', 1, 1, 0, 1, 1, 100, 'confirmed', 0),
        (2, 'PK-BBBB-BBBB', 1, 1, 0, 1, 1, 100, 'checked_in', 0),
        (3, NULL, 1, 1, 0, 1, 1, 100, 'pending_payment', 0);
    `);
    old.close();

    const db = openDb(file);
    const tokens = db.prepare('SELECT id, checkin_token FROM bookings ORDER BY id').all();
    assert.match(tokens[0].checkin_token, /^[0-9A-F]{32}$/);
    assert.match(tokens[1].checkin_token, /^[0-9A-F]{32}$/);
    assert.notEqual(tokens[0].checkin_token, tokens[1].checkin_token);
    assert.equal(tokens[2].checkin_token, null); // never paid, so no pass
    db.close();

    const again = openDb(file); // migrating twice is a no-op
    assert.deepEqual(again.prepare('SELECT id, checkin_token FROM bookings ORDER BY id').all(), tokens);
    assert.throws(() => again.prepare('UPDATE bookings SET checkin_token = ? WHERE id = 3').run(tokens[0].checkin_token), /UNIQUE/);
    assert.throws(() => again.prepare("UPDATE bookings SET checkin_method = 'typed' WHERE id = 1").run(), /CHECK/);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
