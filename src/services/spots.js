import { HOUR_MS } from '../config.js';
import { HttpError } from '../errors.js';
import { resolveWindow, slotsWithStatus } from './availability.js';

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 111.32;
const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Parking spots within `radiusKm` of a point, nearest first, with free-slot counts for the next hour. */
export function findNearby(db, { lat, lng, radiusKm }, now) {
  // Cheap bounding-box filter in SQL, exact great-circle distance in JS.
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const dLng = radiusKm / (KM_PER_DEGREE_LAT * Math.max(Math.cos(toRad(lat)), 0.01));
  const rows = db.prepare('SELECT * FROM parking_spots WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
    .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng);

  return rows
    .map((spot) => ({ ...spot, distance_km: distanceKm({ lat, lng }, spot) }))
    .filter((spot) => spot.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km)
    .map((spot) => {
      const slots = slotsWithStatus(db, spot.id, now, now + HOUR_MS, now);
      return { ...spot, total_slots: slots.length, free_slots: slots.filter((s) => s.status === 'free').length };
    });
}

/** One spot with every slot's status for the requested window. */
export function getSpot(db, spotId, { startAt, hours }, now) {
  const spot = db.prepare('SELECT * FROM parking_spots WHERE id = ?').get(spotId);
  if (!spot) throw new HttpError(404, 'Parking spot not found');
  const window = resolveWindow(startAt, hours, now);
  return {
    ...spot,
    window: { start_at: window.startAt, end_at: window.endAt, hours: window.hours },
    slots: slotsWithStatus(db, spot.id, window.startAt, window.endAt, now),
  };
}
