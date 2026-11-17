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

const ADMIN = { name: 'Admin', email: 'admin@test.dev', password: 'password1' };
const DRIVER = { name: 'Driver', email: 'driver@test.dev', password: 'password1' };

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
    const isJson = res.headers.get('content-type')?.includes('application/json');
    return { status: res.status, headers: res.headers, body: isJson ? await res.json() : null };
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

  const hold = (await call('/api/bookings', { token, method: 'POST', body: { slotId: 1, startAt: Date.now(), hours: 1 } })).body;
  const card = { name: 'D', number: TEST_CARDS.success, expiry: '12/49', cvc: '123' };
  const booking = (await call(`/api/bookings/${hold.id}/pay`, { token, method: 'POST', body: { card } })).body;

  const upcoming = (await call('/api/bookings?scope=upcoming', { token })).body;
  assert.deepEqual(upcoming.bookings.map((b) => b.id), [booking.id]);
  assert.equal(upcoming.has_more, false);
  assert.deepEqual((await call('/api/bookings?scope=history', { token })).body.bookings, []);
  assert.equal((await call('/api/bookings?scope=bogus', { token })).status, 400);
  assert.equal((await call('/api/bookings?limit=abc', { token })).status, 400);

  const receipt = (await call(`/api/bookings/${booking.id}`, { token })).body;
  assert.deepEqual(receipt.payments.map((p) => p.status), ['succeeded']);

  // Check-in is admin-only now; the old shared-key endpoint and page are gone.
  assert.equal((await call('/api/checkin', { method: 'POST', body: { code: booking.code } })).status, 404);
  const legacyPage = await call('/attendant.html');
  assert.equal(legacyPage.status, 301);
  assert.equal(legacyPage.headers.get('location'), '/admin/');
  assert.equal((await call('/api/admin/checkin', { token, method: 'POST', body: { code: booking.code } })).status, 403);
  const checkedIn = await call('/api/admin/checkin', { token: adminToken, method: 'POST', body: { code: booking.code } });
  assert.equal(checkedIn.body.status, 'checked_in');

  const seen = (await call(`/api/admin/bookings?q=${encodeURIComponent(DRIVER.email)}`, { token: adminToken })).body;
  assert.deepEqual(seen.bookings.map((b) => [b.id, b.user_email, b.status]), [[booking.id, DRIVER.email, 'checked_in']]);
  assert.equal((await call(`/api/admin/bookings/${booking.id}`, { token: adminToken })).body.user_name, DRIVER.name);
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
  assert.equal(outbox.length, 1);
  assert.equal((await ask('')).status, 400);

  const resetToken = /#reset=([\w-]+)/.exec(outbox[0].text)[1];
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
