import { transaction } from '../db.js';
import { HttpError } from '../errors.js';
import { ADMIN_BOOKING_SELECT, effectiveStatus, loadAdminBooking, loadOwnBooking, present } from './booking-records.js';
import { passPayload, tokenFromPayload } from './passes.js';

// Check-in happens at the gate: staff scan the QR code on the driver's phone. The QR carries a secret
// check-in token, so only someone holding the pass can use the booking. The booking reference
// (PK-XXXX-XXXX) is for support and searching, and cannot check anyone in. If the driver cannot show
// the QR, staff can check the booking in by hand after confirming who the driver is (recorded as 'manual').

const NO_PASS = {
  pending_payment: 'Pay for this booking to get its QR code',
  expired: 'This reservation expired before it was paid for',
  checked_in: 'This booking has already been checked in',
  completed: 'This booking has ended',
  lapsed: 'This booking has ended',
  cancelled: 'This booking was cancelled',
};

/**
 * The text encoded in the driver's QR pass. Available while the booking can still be checked in
 * (paid, not yet used, not over), including before its window starts so it can be saved in advance.
 */
export function getPassPayload(db, { bookingId, userId }, now) {
  const booking = loadOwnBooking(db, bookingId, userId);
  const status = effectiveStatus(booking, now);
  if (status !== 'confirmed') throw new HttpError(409, NO_PASS[status] ?? 'This booking has no QR code');
  const { checkin_token: token } = db.prepare('SELECT checkin_token FROM bookings WHERE id = ?').get(booking.id);
  return passPayload(token);
}

/** Marks a booking as arrived. Runs inside a transaction so two scans of one pass cannot both succeed. */
function admit(db, booking, { method, staffId }, now) {
  const view = present(booking, now);
  if (booking.status === 'checked_in') throw new HttpError(409, 'This booking has already been checked in', { booking: view });
  if (booking.status === 'cancelled') throw new HttpError(409, 'This booking was cancelled', { booking: view });
  if (booking.status !== 'confirmed') throw new HttpError(409, 'This booking has not been paid for', { booking: view });
  if (now < booking.start_at) throw new HttpError(400, 'This booking has not started yet', { booking: view });
  if (now >= booking.end_at) throw new HttpError(410, 'This booking has already ended', { booking: view });

  db.prepare(`
    UPDATE bookings SET status = 'checked_in', checked_in_at = ?, checkin_method = ?, checked_in_by = ? WHERE id = ?
  `).run(now, method, staffId, booking.id);
  return present(loadAdminBooking(db, booking.id), now);
}

/** Staff scanned a QR code (camera or handheld scanner). `scanned` is the raw text it contained. */
export function checkInWithPass(db, { scanned, staffId }, now) {
  const text = String(scanned ?? '').trim();
  if (!text) throw new HttpError(400, "Scan the driver's QR code");
  const token = tokenFromPayload(text);
  if (!token) {
    const hint = /^PK-/i.test(text)
      ? "Booking references can't be used to check in. Scan the driver's QR code, or find the booking under Bookings to check it in manually."
      : 'This is not a ParkSlot check-in QR code';
    throw new HttpError(400, hint, { reason: 'not_a_pass' });
  }

  return transaction(db, () => {
    const booking = db.prepare(`${ADMIN_BOOKING_SELECT} WHERE b.checkin_token = ?`).get(token);
    if (!booking) throw new HttpError(404, 'This QR code does not match any booking');
    return admit(db, booking, { method: 'qr', staffId }, now);
  });
}

/** Fallback when the driver cannot show their QR code. Staff confirm the driver's identity first. */
export function checkInManually(db, { bookingId, staffId }, now) {
  return transaction(db, () => admit(db, loadAdminBooking(db, bookingId), { method: 'manual', staffId }, now));
}
