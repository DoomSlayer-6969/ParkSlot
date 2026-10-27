import { config, DAY_MS, HOUR_MS, MINUTE_MS } from '../config.js';
import { HttpError } from '../errors.js';

// A booking blocks its slot once paid (confirmed / checked in), and also while
// its payment hold is running so nobody can grab the slot mid-checkout.
// Requires a `$now` parameter.
const BLOCKING = `(b.status IN ('confirmed', 'checked_in')
  OR (b.status = 'pending_payment' AND b.hold_expires_at > $now))`;

/** Validates a requested booking window and returns it as [startAt, endAt). */
export function resolveWindow(startAt, hours, now) {
  if (!Number.isInteger(hours) || hours < 1 || hours > config.maxHours) {
    throw new HttpError(400, `Hours must be a whole number between 1 and ${config.maxHours}`);
  }
  if (!Number.isFinite(startAt)) throw new HttpError(400, 'Start time is required');
  if (startAt < now - config.startGraceMinutes * MINUTE_MS) {
    throw new HttpError(400, 'Start time is in the past');
  }
  if (startAt > now + config.maxAdvanceDays * DAY_MS) {
    throw new HttpError(400, `Bookings can be made at most ${config.maxAdvanceDays} days ahead`);
  }
  startAt = Math.max(startAt, now);
  return { startAt, endAt: startAt + hours * HOUR_MS, hours };
}

/** Returns a blocking booking on the slot that overlaps [startAt, endAt), if any. */
export function findConflict(db, slotId, startAt, endAt, now, excludeBookingId = 0) {
  return db.prepare(`
    SELECT b.id FROM bookings b
    WHERE b.slot_id = $slotId AND b.id != $excludeBookingId
      AND b.start_at < $endAt AND b.end_at > $startAt
      AND ${BLOCKING}
    LIMIT 1
  `).get({ slotId, excludeBookingId, startAt, endAt, now });
}

/**
 * Every slot in a spot with its status for the window [startAt, endAt):
 *   occupied - the car is parked (checked in) during the window
 *   booked   - paid for or being paid for by someone during the window
 *   free     - can be booked for the window
 * `upcoming` lists the slot's blocking bookings (times only, no user data).
 */
export function slotsWithStatus(db, spotId, startAt, endAt, now) {
  const slots = db.prepare('SELECT id, label FROM slots WHERE spot_id = ? ORDER BY id').all(spotId);
  const bookings = db.prepare(`
    SELECT b.slot_id, b.start_at, b.end_at, b.status
    FROM bookings b JOIN slots s ON s.id = b.slot_id
    WHERE s.spot_id = $spotId AND b.end_at > $now AND ${BLOCKING}
    ORDER BY b.start_at
  `).all({ spotId, now });
  const bySlot = Map.groupBy(bookings, (b) => b.slot_id);

  return slots.map((slot) => {
    const upcoming = bySlot.get(slot.id) ?? [];
    const overlapping = upcoming.filter((b) => b.start_at < endAt && b.end_at > startAt);
    let status = 'free';
    if (overlapping.some((b) => b.status === 'checked_in')) status = 'occupied';
    else if (overlapping.length) status = 'booked';
    return {
      id: slot.id,
      label: slot.label,
      status,
      upcoming: upcoming.map((b) => ({ start_at: b.start_at, end_at: b.end_at })),
    };
  });
}
