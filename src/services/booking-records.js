import { HttpError } from '../errors.js';

// Reading bookings back out of the DB, shared by the booking and check-in services.
// The check-in token is deliberately not selected here: it only ever leaves the server as the
// driver's QR code (see checkin.js), never in booking lists or admin views.

const BOOKING_COLUMNS = `
  b.id, b.code, b.user_id, b.slot_id, b.start_at, b.end_at, b.hours, b.amount, b.status,
  b.hold_expires_at, b.checked_in_at, b.created_at,
  s.label AS slot_label, p.id AS spot_id, p.name AS spot_name, p.address AS spot_address`;
const BOOKING_FROM = `
  FROM bookings b
  JOIN slots s ON s.id = b.slot_id
  JOIN parking_spots p ON p.id = s.spot_id`;

export const BOOKING_SELECT = `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM}`;
// Admins also see who made the booking, and how and by whom it was checked in.
export const ADMIN_BOOKING_SELECT = `
  SELECT ${BOOKING_COLUMNS}, u.name AS user_name, u.email AS user_email,
    b.checkin_method, staff.name AS checked_in_by_name
  ${BOOKING_FROM}
  JOIN users u ON u.id = b.user_id
  LEFT JOIN users staff ON staff.id = b.checked_in_by`;

// Statuses that follow from the clock are derived on read rather than stored.
export function effectiveStatus(b, now) {
  if (b.status === 'pending_payment' && b.hold_expires_at <= now) return 'expired';
  if (b.status === 'confirmed' && b.end_at <= now) return 'lapsed';
  if (b.status === 'checked_in' && b.end_at <= now) return 'completed';
  return b.status;
}

export function present(b, now) {
  return { ...b, status: effectiveStatus(b, now) };
}

export function loadBooking(db, bookingId) {
  return db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(bookingId);
}

export function loadAdminBooking(db, bookingId) {
  const booking = db.prepare(`${ADMIN_BOOKING_SELECT} WHERE b.id = ?`).get(bookingId);
  if (!booking) throw new HttpError(404, 'Booking not found');
  return booking;
}

/** A booking that belongs to `userId`. Someone else's booking is reported as missing. */
export function loadOwnBooking(db, bookingId, userId) {
  const booking = loadBooking(db, bookingId);
  if (!booking || booking.user_id !== userId) throw new HttpError(404, 'Booking not found');
  return booking;
}
