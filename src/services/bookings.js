import { randomInt } from 'node:crypto';
import { config, MINUTE_MS } from '../config.js';
import { transaction } from '../db.js';
import { HttpError } from '../errors.js';
import { findConflict, resolveWindow } from './availability.js';
import {
  ADMIN_BOOKING_SELECT, BOOKING_SELECT, loadAdminBooking, loadBooking, loadOwnBooking, present,
} from './booking-records.js';
import { newPassToken } from './passes.js';
import { quoteSpot } from './pricing.js';

// Booking references: no 0/O, 1/I/L so they are easy to read out to support.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// Listing filters, written against the *stored* status since effective statuses are derived.
//   upcoming - holds still running, and paid bookings whose window has not ended (incl. parked now)
//   history  - paid bookings that are over: completed, lapsed (never used) or cancelled with a refund.
//              Abandoned checkouts (expired or released holds) were never paid, so they are left out.
const SCOPES = {
  all: { where: '1', order: 'b.start_at DESC, b.id DESC', usesNow: false },
  upcoming: {
    where: `((b.status IN ('confirmed', 'checked_in') AND b.end_at > $now)
      OR (b.status = 'pending_payment' AND b.hold_expires_at > $now))`,
    order: 'b.start_at ASC, b.id ASC',
    usesNow: true,
  },
  history: {
    where: "(b.code IS NOT NULL AND (b.status = 'cancelled' OR b.end_at <= $now))",
    order: 'b.start_at DESC, b.id DESC',
    usesNow: true,
  },
};
export const BOOKING_SCOPES = Object.keys(SCOPES);

function generateCode(db) {
  for (;;) {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `PK-${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) return code;
  }
}

function recordPayment(db, bookingId, amount, status, ref, last4, now) {
  db.prepare(`
    INSERT INTO payments (booking_id, amount, status, provider_ref, card_last4, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookingId, amount, status, ref ?? null, last4 ?? null, now);
}

/**
 * Step 1: reserve the slot for `config.holdMinutes` while the user pays. The amount is fixed here, at the
 * lot's current price (pricing.js), so refresh the lot's traffic reading before calling this.
 */
export function createHold(db, { userId, slotId, startAt, hours }, now) {
  const window = resolveWindow(startAt, hours, now);
  return transaction(db, () => {
    const slot = db.prepare('SELECT id, spot_id FROM slots WHERE id = ?').get(slotId);
    if (!slot) throw new HttpError(404, 'Slot not found');
    if (findConflict(db, slot.id, window.startAt, window.endAt, now)) {
      throw new HttpError(409, 'This slot is already booked for the selected time');
    }

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bookings (slot_id, user_id, start_at, end_at, hours, amount, status, hold_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?)
    `).run(
      slot.id, userId, window.startAt, window.endAt, window.hours,
      quoteSpot(db, { id: slot.spot_id }, now).hourly_rate * window.hours, now + config.holdMinutes * MINUTE_MS, now,
    );
    return present(loadBooking(db, Number(lastInsertRowid)), now);
  });
}

/**
 * Step 2: charge the card online and, on success, confirm the booking. That issues its reference code
 * and the secret check-in token behind the driver's QR pass (see checkin.js).
 */
export async function payForBooking(db, gateway, { bookingId, userId, card }, clock) {
  const booking = loadOwnBooking(db, bookingId, userId);
  if (booking.status !== 'pending_payment') throw new HttpError(409, 'This booking is not awaiting payment');
  if (booking.hold_expires_at <= clock()) {
    throw new HttpError(410, 'Your reservation expired before payment. Please book the slot again.');
  }

  const charge = await gateway.charge({ amount: booking.amount, currency: config.currency, card });
  const now = clock();
  if (!charge.ok) {
    recordPayment(db, booking.id, booking.amount, 'failed', charge.ref, null, now);
    throw new HttpError(402, charge.error);
  }

  // Other requests ran while we awaited the gateway. The hold normally keeps the
  // slot ours, but if it lapsed mid-payment someone else may have taken it, or a
  // duplicate pay request may have confirmed this booking already.
  const confirmed = transaction(db, () => {
    const { status } = db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.id);
    if (status !== 'pending_payment') return false;
    if (findConflict(db, booking.slot_id, booking.start_at, booking.end_at, now, booking.id)) return false;

    recordPayment(db, booking.id, booking.amount, 'succeeded', charge.ref, charge.last4, now);
    db.prepare(`
      UPDATE bookings SET status = 'confirmed', code = ?, checkin_token = ?, hold_expires_at = NULL WHERE id = ?
    `).run(generateCode(db), newPassToken(), booking.id);
    return true;
  });

  if (!confirmed) {
    const refund = await gateway.refund({ ref: charge.ref, amount: booking.amount });
    recordPayment(db, booking.id, booking.amount, 'refunded', refund.ref, charge.last4, clock());
    throw new HttpError(409, 'This booking could not be confirmed (the slot was taken or it was already paid). Your payment has been refunded.');
  }
  return present(loadBooking(db, booking.id), now);
}

/** Releases an unpaid hold, or cancels a paid booking with a refund if it has not started yet. */
export async function cancelBooking(db, gateway, { bookingId, userId }, clock) {
  const booking = loadOwnBooking(db, bookingId, userId);
  const now = clock();

  if (booking.status === 'pending_payment') {
    db.prepare("UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = ?").run(booking.id);
  } else if (booking.status === 'confirmed' && now < booking.start_at) {
    // Flip the status first so a concurrent cancel cannot refund twice.
    const { changes } = db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'")
      .run(booking.id);
    if (changes) {
      const payment = db.prepare("SELECT * FROM payments WHERE booking_id = ? AND status = 'succeeded'").get(booking.id);
      const refund = await gateway.refund({ ref: payment.provider_ref, amount: payment.amount });
      recordPayment(db, booking.id, payment.amount, 'refunded', refund.ref, payment.card_last4, clock());
    }
  } else {
    throw new HttpError(409, 'Only unpaid bookings, or paid bookings that have not started, can be cancelled');
  }
  return present(loadBooking(db, booking.id), clock());
}

function readPage(limit, offset) {
  if (!Number.isInteger(limit) || limit < 1 || limit > config.maxPageSize) {
    throw new HttpError(400, `limit must be a whole number between 1 and ${config.maxPageSize}`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be a whole number of 0 or more');
  return { limit, offset };
}

/** One page of bookings matching `where` (SQL conditions) and a scope from SCOPES. */
function pageOfBookings(db, select, { where = [], params = {} }, { scope, limit, offset }, now) {
  const view = SCOPES[scope];
  if (!view) throw new HttpError(400, `scope must be one of: ${BOOKING_SCOPES.join(', ')}`);
  const page = readPage(limit, offset);

  // Fetch one extra row to learn whether another page exists.
  const rows = db.prepare(`
    ${select}
    WHERE ${[...where, view.where].join(' AND ')}
    ORDER BY ${view.order}
    LIMIT $limit OFFSET $offset
  `).all({ ...params, ...(view.usesNow ? { now } : {}), limit: page.limit + 1, offset: page.offset });

  const hasMore = rows.length > page.limit;
  return {
    bookings: rows.slice(0, page.limit).map((b) => present(b, now)),
    has_more: hasMore,
    next_offset: hasMore ? page.offset + page.limit : null,
  };
}

/** A driver's own bookings. `scope` is 'all', 'upcoming' or 'history'. */
export function listUserBookings(db, userId, now, { scope = 'all', limit = config.pageSize, offset = 0 } = {}) {
  return pageOfBookings(db, BOOKING_SELECT, { where: ['b.user_id = $userId'], params: { userId } },
    { scope, limit, offset }, now);
}

/** Admin view of every booking. `q` matches part of the booking reference, or the driver's name or email. */
export function listAllBookings(db, now, { q, scope = 'all', limit = config.pageSize, offset = 0 } = {}) {
  const term = String(q ?? '').trim();
  const filter = term
    ? {
      where: ["(b.code LIKE $like ESCAPE '\\' OR u.email LIKE $like ESCAPE '\\' OR u.name LIKE $like ESCAPE '\\')"],
      params: { like: `%${term.replace(/[\\%_]/g, '\\$&')}%` },
    }
    : {};
  return pageOfBookings(db, ADMIN_BOOKING_SELECT, filter, { scope, limit, offset }, now);
}

// Every charge attempt and refund, oldest first. Provider references stay server-side.
function withPayments(db, booking, now) {
  const payments = db.prepare(`
    SELECT status, amount, card_last4, created_at FROM payments WHERE booking_id = ? ORDER BY id
  `).all(booking.id);
  return { ...present(booking, now), payments };
}

/** One of the driver's own bookings with its payment history (the receipt). */
export function getUserBooking(db, { bookingId, userId }, now) {
  return withPayments(db, loadOwnBooking(db, bookingId, userId), now);
}

/** Any booking, with the driver's details and payment history. */
export function getBookingForAdmin(db, bookingId, now) {
  return withPayments(db, loadAdminBooking(db, bookingId), now);
}
