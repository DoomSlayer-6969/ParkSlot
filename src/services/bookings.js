import { randomInt } from 'node:crypto';
import { config, MINUTE_MS } from '../config.js';
import { transaction } from '../db.js';
import { HttpError } from '../errors.js';
import { findConflict, resolveWindow } from './availability.js';

// No 0/O, 1/I/L so the code is easy to read out at the gate.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const BOOKING_SELECT = `
  SELECT b.id, b.code, b.user_id, b.slot_id, b.start_at, b.end_at, b.hours, b.amount, b.status,
         b.hold_expires_at, b.checked_in_at, b.created_at,
         s.label AS slot_label, p.id AS spot_id, p.name AS spot_name, p.address AS spot_address
  FROM bookings b
  JOIN slots s ON s.id = b.slot_id
  JOIN parking_spots p ON p.id = s.spot_id`;

function generateCode(db) {
  for (;;) {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `PK-${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) return code;
  }
}

// Statuses that follow from the clock are derived on read rather than stored.
function effectiveStatus(b, now) {
  if (b.status === 'pending_payment' && b.hold_expires_at <= now) return 'expired';
  if (b.status === 'confirmed' && b.end_at <= now) return 'lapsed';
  if (b.status === 'checked_in' && b.end_at <= now) return 'completed';
  return b.status;
}

function present(b, now) {
  return { ...b, status: effectiveStatus(b, now) };
}

function loadOwnBooking(db, bookingId, userId) {
  const booking = db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(bookingId);
  if (!booking || booking.user_id !== userId) throw new HttpError(404, 'Booking not found');
  return booking;
}

function recordPayment(db, bookingId, amount, status, ref, last4, now) {
  db.prepare(`
    INSERT INTO payments (booking_id, amount, status, provider_ref, card_last4, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookingId, amount, status, ref ?? null, last4 ?? null, now);
}

/** Step 1: reserve the slot for `config.holdMinutes` while the user pays. */
export function createHold(db, { userId, slotId, startAt, hours }, now) {
  const window = resolveWindow(startAt, hours, now);
  return transaction(db, () => {
    const slot = db.prepare(`
      SELECT s.id, p.hourly_rate FROM slots s JOIN parking_spots p ON p.id = s.spot_id WHERE s.id = ?
    `).get(slotId);
    if (!slot) throw new HttpError(404, 'Slot not found');
    if (findConflict(db, slot.id, window.startAt, window.endAt, now)) {
      throw new HttpError(409, 'This slot is already booked for the selected time');
    }

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bookings (slot_id, user_id, start_at, end_at, hours, amount, status, hold_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?)
    `).run(
      slot.id, userId, window.startAt, window.endAt, window.hours,
      slot.hourly_rate * window.hours, now + config.holdMinutes * MINUTE_MS, now,
    );
    return present(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(Number(lastInsertRowid)), now);
  });
}

/** Step 2: charge the card online and, on success, confirm the booking and issue its code. */
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
    db.prepare("UPDATE bookings SET status = 'confirmed', code = ?, hold_expires_at = NULL WHERE id = ?")
      .run(generateCode(db), booking.id);
    return true;
  });

  if (!confirmed) {
    const refund = await gateway.refund({ ref: charge.ref, amount: booking.amount });
    recordPayment(db, booking.id, booking.amount, 'refunded', refund.ref, charge.last4, clock());
    throw new HttpError(409, 'This booking could not be confirmed (the slot was taken or it was already paid). Your payment has been refunded.');
  }
  return present(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(booking.id), now);
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
  return present(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(booking.id), clock());
}

/** Attendant-side: validate the code the driver shows on arrival and mark the slot occupied. */
export function checkIn(db, code, now) {
  const booking = db.prepare(`${BOOKING_SELECT} WHERE b.code = ?`).get(String(code ?? '').trim().toUpperCase());
  if (!booking) throw new HttpError(404, 'No booking found with this ID');

  const view = present(booking, now);
  if (booking.status === 'checked_in') throw new HttpError(409, 'This booking has already been checked in', { booking: view });
  if (booking.status !== 'confirmed') throw new HttpError(409, 'This booking is not active', { booking: view });
  if (now < booking.start_at) throw new HttpError(400, 'This booking has not started yet', { booking: view });
  if (now >= booking.end_at) throw new HttpError(410, 'This booking has already ended', { booking: view });

  db.prepare("UPDATE bookings SET status = 'checked_in', checked_in_at = ? WHERE id = ? AND status = 'confirmed'")
    .run(now, booking.id);
  return present(db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(booking.id), now);
}

export function listUserBookings(db, userId, now) {
  return db.prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.start_at DESC`)
    .all(userId)
    .map((b) => present(b, now));
}
