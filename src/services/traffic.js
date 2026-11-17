// Live traffic around parking lots, used to price them (services/pricing.js).
//
// A traffic provider is any object with `name` and an async `fetchFlow({ lat, lng })` that resolves to
// `{ currentSpeed, freeFlowSpeed, confidence, roadClosure }` for the road nearest the point (null when it
// has no data), or rejects with a TrafficError. createApp() takes one, so tests inject a fake.
//
// Readings are cached per lot in the traffic_readings table, so viewing a lot calls the provider at most
// once every TRAFFIC_CACHE_SECONDS, and restarts don't use up the free quota again.
import { config } from '../config.js';

export class TrafficError extends Error {
  /** `kind`: 'auth' (key rejected), 'rate_limit', 'timeout' or 'unavailable'. */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** No live traffic: lots are priced without a traffic surcharge. */
export function createNoTrafficProvider() {
  return { name: 'none', async fetchFlow() { return null; } };
}

/**
 * TomTom Traffic Flow, "Flow Segment Data" (Traffic API v4): current and free-flow speed on the road
 * segment nearest a point. Free tier with an API key from developer.tomtom.com. Speeds are in km/h.
 */
export function createTomTomTrafficProvider({ apiKey, baseUrl, zoom, timeoutMs }, fetchImpl = globalThis.fetch) {
  if (!apiKey) throw new Error('TomTom traffic needs TOMTOM_API_KEY');
  return {
    name: 'tomtom',
    async fetchFlow({ lat, lng }) {
      const url = `${baseUrl}/traffic/services/4/flowSegmentData/absolute/${zoom}/json?${new URLSearchParams({
        point: `${lat},${lng}`,
        key: apiKey,
      })}`;
      let res;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (err.name === 'TimeoutError') throw new TrafficError('timeout', `TomTom did not answer within ${timeoutMs} ms`);
        throw new TrafficError('unavailable', `cannot reach TomTom (${err.cause?.code ?? err.message})`);
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = body?.detailedError?.message ?? body?.error ?? res.statusText;
        if (res.status === 401 || res.status === 403) throw new TrafficError('auth', `TomTom rejected the API key: ${detail}`);
        if (res.status === 429) throw new TrafficError('rate_limit', 'TomTom rate limit reached (free tier quota)');
        throw new TrafficError('unavailable', `TomTom answered ${res.status}: ${detail}`);
      }
      const flow = body?.flowSegmentData;
      if (!flow || !(flow.freeFlowSpeed > 0) || !(flow.currentSpeed >= 0)) return null;
      return {
        currentSpeed: flow.currentSpeed,
        freeFlowSpeed: flow.freeFlowSpeed,
        confidence: Number.isFinite(flow.confidence) ? flow.confidence : null,
        roadClosure: flow.roadClosure === true,
      };
    },
  };
}

/** The provider chosen by TRAFFIC_PROVIDER (TomTom by default when TOMTOM_API_KEY is set). */
export function createTrafficProviderFromConfig(trafficConfig = config.traffic) {
  return trafficConfig.provider === 'tomtom'
    ? createTomTomTrafficProvider({ ...trafficConfig.tomtom, timeoutMs: trafficConfig.timeoutMs })
    : createNoTrafficProvider();
}

/** 0 when traffic flows freely, 1 at a standstill or when the road is closed. */
export function congestionOf({ currentSpeed, freeFlowSpeed, roadClosure }) {
  if (roadClosure) return 1;
  return Math.min(Math.max(1 - currentSpeed / freeFlowSpeed, 0), 1);
}

/**
 * The lot's latest traffic reading if it is recent enough to price with (TRAFFIC_STALE_SECONDS), else null.
 * Includes `congestion` and `fresh` (younger than TRAFFIC_CACHE_SECONDS).
 */
export function readTraffic(db, spotId, now, trafficConfig = config.traffic) {
  const row = db.prepare('SELECT * FROM traffic_readings WHERE spot_id = ?').get(spotId);
  if (!row || now - row.fetched_at > trafficConfig.staleSeconds * 1000) return null;
  const reading = {
    source: row.source,
    currentSpeed: row.current_speed,
    freeFlowSpeed: row.free_flow_speed,
    confidence: row.confidence,
    roadClosure: Boolean(row.road_closure),
    fetchedAt: row.fetched_at,
  };
  return { ...reading, congestion: congestionOf(reading), fresh: now - row.fetched_at < trafficConfig.cacheSeconds * 1000 };
}

/**
 * Makes the cached readings of `spotIds` current: lots whose reading is older than TRAFFIC_CACHE_SECONDS
 * are fetched from the provider, in parallel. Never throws: when the provider fails, the old reading stays
 * (prices use it until it is TRAFFIC_STALE_SECONDS old) and the provider is left alone for
 * TRAFFIC_RETRY_SECONDS. Async, so it gets the clock (time passes while it waits).
 */
export function createTrafficUpdater(provider, trafficConfig = config.traffic, log = console) {
  const inFlight = new Map(); // spot id -> promise, so concurrent requests share one call
  let pausedUntil = 0;
  let lastWarning = null;

  async function refreshOne(db, spot, clock) {
    try {
      const flow = await provider.fetchFlow({ lat: spot.lat, lng: spot.lng });
      lastWarning = null;
      if (!flow) return;
      db.prepare(`
        INSERT INTO traffic_readings (spot_id, source, current_speed, free_flow_speed, confidence, road_closure, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (spot_id) DO UPDATE SET source = excluded.source, current_speed = excluded.current_speed,
          free_flow_speed = excluded.free_flow_speed, confidence = excluded.confidence,
          road_closure = excluded.road_closure, fetched_at = excluded.fetched_at
      `).run(spot.id, provider.name, flow.currentSpeed, flow.freeFlowSpeed, flow.confidence, flow.roadClosure ? 1 : 0, clock());
    } catch (err) {
      pausedUntil = clock() + trafficConfig.retrySeconds * 1000;
      const warning = `Traffic: ${err.message}. Prices use the last reading (if recent) or no traffic surcharge; retrying in ${trafficConfig.retrySeconds} s.`;
      if (warning !== lastWarning) log.warn(warning); // once per kind of failure, not once per request
      lastWarning = warning;
    }
  }

  return {
    provider,
    async refresh(db, spotIds, clock) {
      if (provider.name === 'none' || !spotIds.length) return;
      const now = clock();
      if (now < pausedUntil) return;
      const due = db.prepare(`
        SELECT p.id, p.lat, p.lng FROM parking_spots p
        LEFT JOIN traffic_readings t ON t.spot_id = p.id
        WHERE p.id IN (${spotIds.map(() => '?').join(',')})
          AND (t.fetched_at IS NULL OR t.fetched_at <= ?)
      `).all(...spotIds, now - trafficConfig.cacheSeconds * 1000);
      await Promise.all(due.map((spot) => {
        if (!inFlight.has(spot.id)) {
          inFlight.set(spot.id, refreshOne(db, spot, clock).finally(() => inFlight.delete(spot.id)));
        }
        return inFlight.get(spot.id);
      }));
    },
  };
}
