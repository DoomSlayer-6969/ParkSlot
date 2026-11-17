// Dynamic hourly prices. A lot's rate depends on two things:
//   traffic around it   factor = 1 + TRAFFIC_PRICE_WEIGHT × congestion   (congestion 0 = free-flowing … 1 = jammed)
//   how many slots it has  factor = (CAPACITY_REFERENCE_SLOTS / slots) ^ CAPACITY_PRICE_ELASTICITY
//                          (fewer slots, scarcer parking: dearer; bigger lots: cheaper)
// hourly rate = BASE_HOURLY_RATE × traffic factor × lot-size factor, rounded to PRICE_ROUNDING and kept
// within [MIN_HOURLY_RATE, MAX_HOURLY_RATE]. Without a live traffic reading the traffic factor is 1.
//
// The price is quoted from the traffic *now* and fixed when the driver books (it is stored in the
// booking's amount), whatever time the booking is for.
import { config } from '../config.js';
import { readTraffic } from './traffic.js';

const round2 = (n) => Math.round(n * 100) / 100;

/** 'light' | 'moderate' | 'heavy' | 'severe', or 'unknown' without a reading. */
export function trafficLevel(congestion, thresholds = config.traffic.levelThresholds) {
  if (congestion == null) return 'unknown';
  const [moderate, heavy, severe] = thresholds;
  if (congestion >= severe) return 'severe';
  if (congestion >= heavy) return 'heavy';
  if (congestion >= moderate) return 'moderate';
  return 'light';
}

/**
 * The hourly rate for a lot with `slots` slots, given the congestion around it (null when unknown),
 * with the breakdown shown to drivers.
 */
export function priceFor({ slots, congestion = null }, pricing = config.pricing, thresholds = config.traffic.levelThresholds) {
  const trafficMultiplier = congestion == null ? 1 : 1 + pricing.trafficWeight * congestion;
  const capacityMultiplier = (pricing.capacityReferenceSlots / Math.max(slots, 1)) ** pricing.capacityElasticity;
  const raw = pricing.baseHourlyRate * trafficMultiplier * capacityMultiplier;
  const rounded = Math.round(raw / pricing.rounding) * pricing.rounding;
  return {
    hourly_rate: Math.min(Math.max(rounded, pricing.minHourlyRate), pricing.maxHourlyRate),
    base_rate: pricing.baseHourlyRate,
    traffic: { level: trafficLevel(congestion, thresholds), congestion: congestion == null ? null : round2(congestion), multiplier: round2(trafficMultiplier) },
    capacity: { slots, multiplier: round2(capacityMultiplier) },
  };
}

/**
 * The current price of a lot, from its slot count and its cached traffic reading (see
 * traffic.js: refresh the reading first, outside any transaction). `spot` needs `id`; pass `slots` when
 * already known to save a query.
 */
export function quoteSpot(db, { id, slots }, now) {
  const slotCount = slots ?? db.prepare('SELECT COUNT(*) AS n FROM slots WHERE spot_id = ?').get(id).n;
  const reading = readTraffic(db, id, now);
  const price = priceFor({ slots: slotCount, congestion: reading?.congestion ?? null });
  if (reading) {
    Object.assign(price.traffic, {
      source: reading.source,
      current_speed_kmh: reading.currentSpeed,
      free_flow_speed_kmh: reading.freeFlowSpeed,
      road_closure: reading.roadClosure,
      observed_at: reading.fetchedAt,
    });
  }
  return price;
}
