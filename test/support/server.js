import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { openDb } from '../../src/db.js';
import { createMockGateway, TEST_CARDS } from '../../src/services/payments.js';

export const CARD = { name: 'Test Driver', number: TEST_CARDS.success, expiry: '12/49', cvc: '123' };

/** A mailer that keeps every message in `outbox` instead of sending it. */
export function fakeMailer() {
  const outbox = [];
  return { outbox, send: async (message) => { outbox.push(message); } };
}

/**
 * Runs the real HTTP app on a random port against a fresh in-memory DB, closed when the test ends.
 * `setup(db)` runs before the server starts (insert spots, create admins...). `call(path, options)`
 * returns `{ status, headers, body }` with JSON or SVG bodies decoded.
 */
export async function startServer(t, { mailer = fakeMailer(), setup } = {}) {
  const db = openDb(':memory:');
  setup?.(db);
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
  return { db, base, call, outbox: mailer.outbox };
}

/** Holds slot `slotId` for an hour from now and pays for it as the driver with `token`. */
export async function bookAndPay(call, token, { slotId = 1 } = {}) {
  const hold = (await call('/api/bookings', { token, method: 'POST', body: { slotId, startAt: Date.now(), hours: 1 } })).body;
  return (await call(`/api/bookings/${hold.id}/pay`, { token, method: 'POST', body: { card: CARD } })).body;
}
