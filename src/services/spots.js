import { HOUR_MS } from '../config.js';
import { HttpError } from '../errors.js';
import { resolveWindow, slotsWithStatus } from './availability.js';
import { quoteSpot } from './pricing.js';

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 111.32;
const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Lots within `radiusKm` of a point, nearest first, with `distance_km`. */
export function spotsWithin(db, { lat, lng, radiusKm }) {
  // Cheap bounding-box filter in SQL, exact great-circle distance in JS.
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const dLng = radiusKm / (KM_PER_DEGREE_LAT * Math.max(Math.cos(toRad(lat)), 0.01));
  return db.prepare('SELECT * FROM parking_spots WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
    .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng)
    .map((spot) => ({ ...spot, distance_km: distanceKm({ lat, lng }, spot) }))
    .filter((spot) => spot.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km);
}

/**
 * Parking lots within `radiusKm` of a point, nearest first, with free-slot counts for the next hour and
 * the current price (`hourly_rate` and its breakdown, `pricing`). Prices use cached traffic readings, so
 * refresh them first (createTrafficUpdater().refresh).
 */
export function findNearby(db, { lat, lng, radiusKm }, now) {
  return spotsWithin(db, { lat, lng, radiusKm }).map((spot) => {
    const slots = slotsWithStatus(db, spot.id, now, now + HOUR_MS, now);
    const { hourly_rate: hourlyRate, ...pricing } = quoteSpot(db, { id: spot.id, slots: slots.length }, now);
    return {
      ...spot,
      total_slots: slots.length,
      free_slots: slots.filter((s) => s.status === 'free').length,
      hourly_rate: hourlyRate,
      pricing,
    };
  });
}

/** One lot with every slot's status for the requested window, and its current price. */
export function getSpot(db, spotId, { startAt, hours }, now) {
  const spot = db.prepare('SELECT * FROM parking_spots WHERE id = ?').get(spotId);
  if (!spot) throw new HttpError(404, 'Parking spot not found');
  const window = resolveWindow(startAt, hours, now);
  const slots = slotsWithStatus(db, spot.id, window.startAt, window.endAt, now);
  const { hourly_rate: hourlyRate, ...pricing } = quoteSpot(db, { id: spot.id, slots: slots.length }, now);
  return {
    ...spot,
    hourly_rate: hourlyRate,
    pricing,
    window: { start_at: window.startAt, end_at: window.endAt, hours: window.hours },
    slots,
  };
}

/** The lot a slot belongs to (for refreshing its traffic before a booking), or undefined. */
export function spotIdOfSlot(db, slotId) {
  return db.prepare('SELECT spot_id FROM slots WHERE id = ?').get(slotId)?.spot_id;
}
