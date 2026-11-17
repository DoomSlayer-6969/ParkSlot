import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR_MS, MINUTE_MS } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createAccount, register } from '../src/services/auth.js';
import {
  cancelBooking, createHold, getBookingForAdmin, getUserBooking, listAllBookings, listUserBookings, payForBooking,
} from '../src/services/bookings.js';
import { checkInManually, checkInWithPass, getPassPayload } from '../src/services/checkin.js';
import { createMockGateway, TEST_CARDS } from '../src/services/payments.js';
import { quoteSpot } from '../src/services/pricing.js';
import { findNearby, getSpot } from '../src/services/spots.js';

const T0 = Date.UTC(2030, 0, 1, 10);
const card = (number = TEST_CARDS.success) => ({ name: 'Test', number, expiry: '12/49', cvc: '123' });

function setup() {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO parking_spots (id, name, address, lat, lng) VALUES
      (1, 'Near Lot', '1 Test Rd', 10.000, 20.000),
      (2, 'Far Lot',  '9 Test Rd', 10.020, 20.000),
      (3, 'Out of range', 'Elsewhere', 10.500, 20.000);
    INSERT INTO slots (id, spot_id, label) VALUES (1, 1, 'A1'), (2, 1, 'A2'), (3, 2, 'A1');
  `);
  let now = T0;
  const clock = () => now;
  const user = (name) => register(db, { name, email: `${name}@test.dev`, password: 'password1' }, T0).user.id;
  const staff = createAccount(db, { name: 'Gate Staff', email: 'staff@test.dev', password: 'password1', role: 'admin' }, T0);
  return {
    db, clock, advance: (ms) => { now += ms; }, alice: user('alice'), bob: user('bob'), staff: staff.id,
    gateway: createMockGateway(),
  };
}

/** What the gate scanner reads off the driver's QR pass. */
const passOf = (ctx, booking) => getPassPayload(ctx.db, { bookingId: booking.id, userId: booking.user_id }, ctx.clock());
const scan = (ctx, scanned) => checkInWithPass(ctx.db, { scanned, staffId: ctx.staff }, ctx.clock());

/** The current hourly price of a lot (no traffic readings in these tests, so it follows from lot size). */
const rateOf = (ctx, spotId) => quoteSpot(ctx.db, { id: spotId }, ctx.clock()).hourly_rate;

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
  assert.equal(a.amount, 3 * rateOf(ctx, 1));
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
  assert.equal(listUserBookings(ctx.db, ctx.alice, ctx.clock()).bookings[0].status, 'expired');
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
  assert.deepEqual(refunds, [{ ref: 'slow_1', amount: rateOf(ctx, 1) }]);
  const confirmed = ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE slot_id = 1 AND status = 'confirmed'").get();
  assert.equal(confirmed.n, 1);
});

// ---------------------------------------------------------------- QR check-in

test('a paid booking gets a QR pass with its own secret token; unpaid holds and other users get none', async () => {
  const ctx = setup();
  const a = await bookAndPay(ctx, ctx.alice, { slotId: 1 });
  const b = await bookAndPay(ctx, ctx.bob, { slotId: 2 });
  assert.match(passOf(ctx, a), /^PARKSLOT:[0-9A-F]{32}$/);
  assert.notEqual(passOf(ctx, a), passOf(ctx, b));
  assert.equal(passOf(ctx, a), passOf(ctx, a)); // the same pass every time it is shown
  assert.ok(!passOf(ctx, a).includes(a.code)); // the pass is not derived from the reference

  // The token never appears in booking data, only in the QR.
  const token = passOf(ctx, a).split(':')[1];
  for (const seen of [a, getUserBooking(ctx.db, { bookingId: a.id, userId: ctx.alice }, ctx.clock()),
    getBookingForAdmin(ctx.db, a.id, ctx.clock()), ...listAllBookings(ctx.db, ctx.clock()).bookings]) {
    assert.ok(!JSON.stringify(seen).includes(token));
  }

  const hold = createHold(ctx.db, { userId: ctx.alice, slotId: 3, startAt: T0, hours: 1 }, ctx.clock());
  assert.throws(() => passOf(ctx, hold), { status: 409, message: /Pay for this booking/ });
  assert.throws(() => getPassPayload(ctx.db, { bookingId: a.id, userId: ctx.bob }, ctx.clock()), { status: 404 });
});

test('scanning the pass checks in any time within the booked window, once', async () => {
  const ctx = setup();
  const booking = await bookAndPay(ctx, ctx.alice, { startAt: T0 + HOUR_MS, hours: 2 });
  const pass = passOf(ctx, booking); // drivers can get their pass before the window starts

  assert.throws(() => scan(ctx, pass), { status: 400, message: /not started/ });
  ctx.advance(2.5 * HOUR_MS);
  // Handheld scanners type the payload into a text box, so case and stray whitespace are tolerated.
  const checkedIn = scan(ctx, ` ${pass.toLowerCase()}\n`);
  assert.equal(checkedIn.status, 'checked_in');
  assert.equal(checkedIn.checkin_method, 'qr');
  assert.equal(checkedIn.checked_in_by_name, 'Gate Staff');
  assert.equal(checkedIn.user_name, 'alice'); // staff see whose booking it is
  assert.equal(checkedIn.checked_in_at, ctx.clock());

  const again = (() => { try { scan(ctx, pass); } catch (err) { return err; } })();
  assert.equal(again.status, 409);
  assert.equal(again.extra.booking.id, booking.id);
  assert.equal(getSpot(ctx.db, 1, { startAt: ctx.clock(), hours: 1 }, ctx.clock()).slots[0].status, 'occupied');
  assert.throws(() => passOf(ctx, booking), { status: 409, message: /already been checked in/ });
});

test('only a genuine pass checks in: the booking reference, other QR codes and made-up tokens do not', async () => {
  const ctx = setup();
  const booking = await bookAndPay(ctx, ctx.alice, { startAt: T0, hours: 1 });

  assert.throws(() => scan(ctx, booking.code), { status: 400, message: /references can't be used/ });
  assert.throws(() => scan(ctx, 'https://example.com/'), { status: 400, message: /not a ParkSlot/ });
  assert.throws(() => scan(ctx, 'PARKSLOT:1234'), { status: 400 });
  assert.throws(() => scan(ctx, ''), { status: 400 });
  assert.throws(() => scan(ctx, undefined), { status: 400 });
  assert.throws(() => scan(ctx, `PARKSLOT:${'A'.repeat(32)}`), { status: 404 });
  assert.equal(getUserBooking(ctx.db, { bookingId: booking.id, userId: ctx.alice }, ctx.clock()).status, 'confirmed');
});

test('a pass is refused after the window ends, or once the booking is cancelled', async () => {
  const ctx = setup();
  const ended = await bookAndPay(ctx, ctx.alice, { slotId: 1, startAt: T0, hours: 1 });
  const cancelled = await bookAndPay(ctx, ctx.alice, { slotId: 2, startAt: T0 + 2 * HOUR_MS, hours: 1 });
  const endedPass = passOf(ctx, ended);
  const cancelledPass = passOf(ctx, cancelled);
  await cancelBooking(ctx.db, ctx.gateway, { bookingId: cancelled.id, userId: ctx.alice }, ctx.clock);
  assert.throws(() => passOf(ctx, cancelled), { status: 409, message: /cancelled/ });

  ctx.advance(2 * HOUR_MS);
  assert.throws(() => scan(ctx, endedPass), { status: 410 });
  assert.throws(() => passOf(ctx, ended), { status: 409, message: /ended/ });
  assert.throws(() => scan(ctx, cancelledPass), { status: 409, message: /cancelled/ });
});

test('staff can check a booking in manually, under the same rules, and it is recorded as manual', async () => {
  const ctx = setup();
  const booking = await bookAndPay(ctx, ctx.alice, { startAt: T0 + HOUR_MS, hours: 1 });
  const hold = createHold(ctx.db, { userId: ctx.bob, slotId: 2, startAt: T0, hours: 1 }, ctx.clock());
  const manual = (bookingId) => checkInManually(ctx.db, { bookingId, staffId: ctx.staff }, ctx.clock());

  assert.throws(() => manual(booking.id), { status: 400 }); // not started
  assert.throws(() => manual(hold.id), { status: 409, message: /not been paid/ });
  assert.throws(() => manual(9999), { status: 404 });
  ctx.advance(HOUR_MS);
  const checkedIn = manual(booking.id);
  assert.deepEqual([checkedIn.status, checkedIn.checkin_method, checkedIn.checked_in_by_name], ['checked_in', 'manual', 'Gate Staff']);
  assert.throws(() => manual(booking.id), { status: 409 });
  assert.throws(() => scan(ctx, `PARKSLOT:${'0'.repeat(32)}`), { status: 404 });
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

// ---------------------------------------------------------------- booking history

test('booking history lists finished paid bookings, newest first, and leaves out abandoned checkouts', async () => {
  const ctx = setup();
  const lapsed = await bookAndPay(ctx, ctx.alice, { slotId: 1, startAt: T0, hours: 1 });
  const completed = await bookAndPay(ctx, ctx.alice, { slotId: 2, startAt: T0, hours: 1 });
  scan(ctx, passOf(ctx, completed));
  const refunded = await bookAndPay(ctx, ctx.alice, { slotId: 1, startAt: T0 + 3 * HOUR_MS, hours: 1 });
  await cancelBooking(ctx.db, ctx.gateway, { bookingId: refunded.id, userId: ctx.alice }, ctx.clock);
  const released = createHold(ctx.db, { userId: ctx.alice, slotId: 2, startAt: T0 + 5 * HOUR_MS, hours: 1 }, ctx.clock());
  await cancelBooking(ctx.db, ctx.gateway, { bookingId: released.id, userId: ctx.alice }, ctx.clock);
  createHold(ctx.db, { userId: ctx.alice, slotId: 3, startAt: T0 + 4 * HOUR_MS, hours: 1 }, ctx.clock()); // will expire
  const future = await bookAndPay(ctx, ctx.alice, { slotId: 1, startAt: T0 + 48 * HOUR_MS, hours: 1 });
  await bookAndPay(ctx, ctx.bob, { slotId: 3, startAt: T0 + 24 * HOUR_MS, hours: 1 });

  ctx.advance(2 * HOUR_MS);
  const list = (scope, page = {}) => listUserBookings(ctx.db, ctx.alice, ctx.clock(), { scope, ...page });

  const history = list('history');
  assert.deepEqual(history.bookings.map((b) => [b.id, b.status]), [
    [refunded.id, 'cancelled'],
    [completed.id, 'completed'],
    [lapsed.id, 'lapsed'],
  ]);
  assert.equal(history.has_more, false);
  assert.deepEqual(list('upcoming').bookings.map((b) => b.id), [future.id]);
  assert.equal(list('all').bookings.length, 6); // everything of Alice's, none of Bob's

  const first = list('history', { limit: 2 });
  assert.deepEqual([first.bookings.length, first.has_more, first.next_offset], [2, true, 2]);
  const second = list('history', { limit: 2, offset: first.next_offset });
  assert.deepEqual([second.bookings.map((b) => b.id), second.has_more, second.next_offset], [[lapsed.id], false, null]);

  assert.throws(() => list('bogus'), { status: 400 });
  assert.throws(() => list('history', { limit: 0 }), { status: 400 });
  assert.throws(() => list('history', { limit: 101 }), { status: 400 });
  assert.throws(() => list('history', { offset: -1 }), { status: 400 });
});

test('a booking receipt lists every payment attempt and refund, and only its owner can see it', async () => {
  const ctx = setup();
  const hold = createHold(ctx.db, { userId: ctx.alice, slotId: 1, startAt: T0 + HOUR_MS, hours: 2 }, ctx.clock());
  const pay = (number) => payForBooking(ctx.db, ctx.gateway, { bookingId: hold.id, userId: ctx.alice, card: card(number) }, ctx.clock);
  await assert.rejects(pay(TEST_CARDS.declined), { status: 402 });
  await pay(TEST_CARDS.success);
  await cancelBooking(ctx.db, ctx.gateway, { bookingId: hold.id, userId: ctx.alice }, ctx.clock);

  const receipt = getUserBooking(ctx.db, { bookingId: hold.id, userId: ctx.alice }, ctx.clock());
  assert.equal(receipt.status, 'cancelled');
  const paid = 2 * rateOf(ctx, 1);
  assert.deepEqual(receipt.payments.map((p) => [p.status, p.amount, p.card_last4]), [
    ['failed', paid, null],
    ['succeeded', paid, '4242'],
    ['refunded', paid, '4242'],
  ]);
  assert.ok(!('provider_ref' in receipt.payments[0]));
  assert.throws(() => getUserBooking(ctx.db, { bookingId: hold.id, userId: ctx.bob }, ctx.clock()), { status: 404 });
});

test('admins can search every booking by reference, driver name or email', async () => {
  const ctx = setup();
  const alices = await bookAndPay(ctx, ctx.alice, { slotId: 1 });
  const bobs = await bookAndPay(ctx, ctx.bob, { slotId: 2 });
  const search = (q) => listAllBookings(ctx.db, ctx.clock(), { q }).bookings.map((b) => b.id);

  assert.deepEqual(search('').sort(), [alices.id, bobs.id].sort());
  assert.deepEqual(search('BOB@test'), [bobs.id]);
  assert.deepEqual(search('alice'), [alices.id]);
  assert.deepEqual(search(alices.code.toLowerCase()), [alices.id]);
  assert.deepEqual(search('%'), []); // LIKE wildcards are matched literally
  assert.equal(listAllBookings(ctx.db, ctx.clock()).bookings[0].user_email.endsWith('@test.dev'), true);
});
