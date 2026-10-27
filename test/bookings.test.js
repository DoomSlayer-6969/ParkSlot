import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR_MS, MINUTE_MS } from '../src/config.js';
import { openDb } from '../src/db.js';
import { register } from '../src/services/auth.js';
import { cancelBooking, checkIn, createHold, listUserBookings, payForBooking } from '../src/services/bookings.js';
import { createMockGateway, TEST_CARDS } from '../src/services/payments.js';
import { findNearby, getSpot } from '../src/services/spots.js';

const T0 = Date.UTC(2030, 0, 1, 10);
const card = (number = TEST_CARDS.success) => ({ name: 'Test', number, expiry: '12/49', cvc: '123' });

function setup() {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO parking_spots (id, name, address, lat, lng, hourly_rate) VALUES
      (1, 'Near Lot', '1 Test Rd', 10.000, 20.000, 5000),
      (2, 'Far Lot',  '9 Test Rd', 10.020, 20.000, 3000),
      (3, 'Out of range', 'Elsewhere', 10.500, 20.000, 3000);
    INSERT INTO slots (id, spot_id, label) VALUES (1, 1, 'A1'), (2, 1, 'A2'), (3, 2, 'A1');
  `);
  let now = T0;
  const clock = () => now;
  const user = (name) => register(db, { name, email: `${name}@test.dev`, password: 'password1' }, T0).user.id;
  return { db, clock, advance: (ms) => { now += ms; }, alice: user('alice'), bob: user('bob'), gateway: createMockGateway() };
}

async function bookAndPay(ctx, userId, { slotId = 1, startAt = T0, hours = 2 } = {}) {
  const hold = createHold(ctx.db, { userId, slotId, startAt, hours }, ctx.clock());
  return payForBooking(ctx.db, ctx.gateway, { bookingId: hold.id, userId, card: card() }, ctx.clock);
}

test('two users cannot book the same slot for overlapping times', async () => {
  const ctx = setup();
  await bookAndPay(ctx, ctx.alice, { startAt: T0, hours: 2 });
  assert.throws(
    () => createHold(ctx.db, { userId: ctx.bob, slotId: 1, startAt: T0 + HOUR_MS, hours: 1 }, ctx.clock()),
    { status: 409 },
  );
  // A different slot in the same spot is still bookable.
  assert.equal(createHold(ctx.db, { userId: ctx.bob, slotId: 2, startAt: T0, hours: 1 }, ctx.clock()).status, 'pending_payment');
});

test('an unpaid hold also blocks the slot until it expires', () => {
  const ctx = setup();
  createHold(ctx.db, { userId: ctx.alice, slotId: 1, startAt: T0, hours: 1 }, ctx.clock());
  assert.throws(() => createHold(ctx.db, { userId: ctx.bob, slotId: 1, startAt: T0, hours: 1 }, ctx.clock()), { status: 409 });
});

test('back-to-back bookings on the same slot are allowed', async () => {
  const ctx = setup();
  await bookAndPay(ctx, ctx.alice, { startAt: T0, hours: 2 });
  const next = await bookAndPay(ctx, ctx.bob, { startAt: T0 + 2 * HOUR_MS, hours: 1 });
  assert.equal(next.status, 'confirmed');
});

test('a paid booking gets a unique code, hourly price, and shows as booked', async () => {
  const ctx = setup();
  const a = await bookAndPay(ctx, ctx.alice, { slotId: 1, hours: 3 });
  const b = await bookAndPay(ctx, ctx.bob, { slotId: 2, hours: 1 });
  assert.match(a.code, /^PK-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(a.amount, 3 * 5000);
  assert.equal(a.status, 'confirmed');

  const spot = getSpot(ctx.db, 1, { startAt: T0, hours: 1 }, ctx.clock());
  assert.deepEqual(spot.slots.map((s) => s.status), ['booked', 'booked']);
  const later = getSpot(ctx.db, 1, { startAt: T0 + 3 * HOUR_MS, hours: 1 }, ctx.clock());
  assert.deepEqual(later.slots.map((s) => s.status), ['free', 'free']);
});

test('an expired hold releases the slot and can no longer be paid', async () => {
  const ctx = setup();
  const hold = createHold(ctx.db, { userId: ctx.alice, slotId: 1, startAt: T0 + HOUR_MS, hours: 1 }, ctx.clock());
  ctx.advance(11 * MINUTE_MS);
  await bookAndPay(ctx, ctx.bob, { slotId: 1, startAt: T0 + HOUR_MS, hours: 1 });
  await assert.rejects(
    payForBooking(ctx.db, ctx.gateway, { bookingId: hold.id, userId: ctx.alice, card: card() }, ctx.clock),
    { status: 410 },
  );
  assert.equal(listUserBookings(ctx.db, ctx.alice, ctx.clock())[0].status, 'expired');
});

test('a declined card leaves the booking unpaid and retryable', async () => {
  const ctx = setup();
  const hold = createHold(ctx.db, { userId: ctx.alice, slotId: 1, startAt: T0, hours: 1 }, ctx.clock());
  const pay = (number) => payForBooking(ctx.db, ctx.gateway, { bookingId: hold.id, userId: ctx.alice, card: card(number) }, ctx.clock);

  await assert.rejects(pay(TEST_CARDS.declined), { status: 402 });
  await assert.rejects(pay('1234'), { status: 402 });
  assert.equal((await pay(TEST_CARDS.success)).status, 'confirmed');
});

test('users cannot pay for or cancel someone else\'s booking', async () => {
  const ctx = setup();
  const hold = createHold(ctx.db, { userId: ctx.alice, slotId: 1, startAt: T0, hours: 1 }, ctx.clock());
  await assert.rejects(payForBooking(ctx.db, ctx.gateway, { bookingId: hold.id, userId: ctx.bob, card: card() }, ctx.clock), { status: 404 });
  await assert.rejects(cancelBooking(ctx.db, ctx.gateway, { bookingId: hold.id, userId: ctx.bob }, ctx.clock), { status: 404 });
});

test('if the slot is taken while a slow payment is in flight, the payer is refunded', async () => {
  const ctx = setup();
  let completeCharge;
  const refunds = [];
  const slowGateway = {
    charge: () => new Promise((resolve) => { completeCharge = () => resolve({ ok: true, ref: 'slow_1', last4: '4242' }); }),
    refund: async (req) => { refunds.push(req); return { ok: true, ref: 'rf_1' }; },
  };

  const hold = createHold(ctx.db, { userId: ctx.alice, slotId: 1, startAt: T0 + HOUR_MS, hours: 1 }, ctx.clock());
  const alicePays = payForBooking(ctx.db, slowGateway, { bookingId: hold.id, userId: ctx.alice, card: card() }, ctx.clock);

  ctx.advance(11 * MINUTE_MS); // Alice's hold lapses while her bank is slow...
  await bookAndPay(ctx, ctx.bob, { slotId: 1, startAt: T0 + HOUR_MS, hours: 1 }); // ...and Bob takes the slot.
  completeCharge();

  await assert.rejects(alicePays, { status: 409 });
  assert.deepEqual(refunds, [{ ref: 'slow_1', amount: 5000 }]);
  const confirmed = ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE slot_id = 1 AND status = 'confirmed'").get();
  assert.equal(confirmed.n, 1);
});

test('check-in works any time within the booked window, once', async () => {
  const ctx = setup();
  const booking = await bookAndPay(ctx, ctx.alice, { startAt: T0 + HOUR_MS, hours: 2 });

  assert.throws(() => checkIn(ctx.db, booking.code, ctx.clock()), { status: 400 }); // too early
  ctx.advance(2.5 * HOUR_MS);
  assert.equal(checkIn(ctx.db, booking.code.toLowerCase(), ctx.clock()).status, 'checked_in');
  assert.throws(() => checkIn(ctx.db, booking.code, ctx.clock()), { status: 409 }); // already used
  assert.equal(getSpot(ctx.db, 1, { startAt: ctx.clock(), hours: 1 }, ctx.clock()).slots[0].status, 'occupied');

  assert.throws(() => checkIn(ctx.db, 'PK-NOPE-NOPE', ctx.clock()), { status: 404 });
});

test('check-in after the window has ended is rejected', async () => {
  const ctx = setup();
  const booking = await bookAndPay(ctx, ctx.alice, { startAt: T0, hours: 1 });
  ctx.advance(HOUR_MS);
  assert.throws(() => checkIn(ctx.db, booking.code, ctx.clock()), { status: 410 });
});

test('cancelling a paid booking before it starts refunds it and frees the slot', async () => {
  const ctx = setup();
  const booking = await bookAndPay(ctx, ctx.alice, { startAt: T0 + HOUR_MS, hours: 1 });
  const cancelled = await cancelBooking(ctx.db, ctx.gateway, { bookingId: booking.id, userId: ctx.alice }, ctx.clock);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(ctx.db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND status = 'refunded'").get(booking.id));
  assert.equal((await bookAndPay(ctx, ctx.bob, { startAt: T0 + HOUR_MS, hours: 1 })).status, 'confirmed');
});

test('booking window validation', () => {
  const ctx = setup();
  const hold = (startAt, hours) => () => createHold(ctx.db, { userId: ctx.alice, slotId: 1, startAt, hours }, ctx.clock());
  assert.throws(hold(T0, 0), { status: 400 });
  assert.throws(hold(T0, 1.5), { status: 400 });
  assert.throws(hold(T0, 25), { status: 400 });
  assert.throws(hold(T0 - HOUR_MS, 1), { status: 400 });
  assert.throws(hold(T0 + 8 * 24 * HOUR_MS, 1), { status: 400 });
  // A start a few minutes in the past is treated as "now".
  assert.equal(hold(T0 - 5 * MINUTE_MS, 1)().start_at, T0);
});

test('nearby search returns only spots within the radius, nearest first', () => {
  const ctx = setup();
  const spots = findNearby(ctx.db, { lat: 10, lng: 20, radiusKm: 3 }, ctx.clock());
  assert.deepEqual(spots.map((s) => s.name), ['Near Lot', 'Far Lot']);
  assert.equal(spots[0].total_slots, 2);
  assert.equal(spots[0].free_slots, 2);
});
