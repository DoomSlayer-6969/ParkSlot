import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import {
  createNoTrafficProvider, createTomTomTrafficProvider, createTrafficUpdater, readTraffic, TrafficError,
} from '../src/services/traffic.js';
import { startServer } from './support/server.js';

const T0 = Date.UTC(2030, 0, 1, 10);
const TRAFFIC = { cacheSeconds: 600, staleSeconds: 3600, retrySeconds: 120, timeoutMs: 300, levelThresholds: [0.15, 0.35, 0.6] };

/**
 * A stand-in for TomTom's Flow Segment Data endpoint, answering in the documented format. The API key
 * picks the behaviour: 'good' (41 of 70 km/h), 'bad' (401 like the real API with an invalid key),
 * 'limited' (429), 'broken' (500), 'slow' (never answers).
 */
async function startFakeTomTom(t) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(url);
    const key = url.searchParams.get('key');
    const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (key === 'slow') return;
    if (key === 'bad') return send(401, { detailedError: { code: 'Unauthorized', message: 'You are missing valid authentication credentials' } });
    if (key === 'limited') return send(429, { error: 'Too Many Requests', httpStatusCode: 429 });
    if (key === 'broken') return send(500, { error: 'Internal Server Error', httpStatusCode: 500 });
    send(200, {
      flowSegmentData: {
        '@version': 'traffic-service 4.0.011', frc: 'FRC2', currentSpeed: 41, freeFlowSpeed: 70,
        currentTravelTime: 153, freeFlowTravelTime: 90, confidence: 0.59, roadClosure: false,
        coordinates: { coordinate: [{ latitude: 28.63, longitude: 77.21 }] },
      },
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const tomtom = (apiKey) => createTomTomTrafficProvider({ apiKey, baseUrl: `http://127.0.0.1:${server.address().port}`, zoom: 10, timeoutMs: 300 });
  return { requests, tomtom };
}

test('the TomTom provider asks Flow Segment Data about the point and returns its speeds', async (t) => {
  const { requests, tomtom } = await startFakeTomTom(t);
  const flow = await tomtom('good').fetchFlow({ lat: 28.6327, lng: 77.2195 });
  assert.deepEqual(flow, { currentSpeed: 41, freeFlowSpeed: 70, confidence: 0.59, roadClosure: false });
  assert.equal(requests[0].pathname, '/traffic/services/4/flowSegmentData/absolute/10/json');
  assert.equal(requests[0].searchParams.get('point'), '28.6327,77.2195');
  assert.equal(requests[0].searchParams.get('key'), 'good');
});

test('TomTom failures become typed errors', async (t) => {
  const { tomtom } = await startFakeTomTom(t);
  const fails = (key, kind, message) => assert.rejects(tomtom(key).fetchFlow({ lat: 1, lng: 2 }), (err) => {
    assert.ok(err instanceof TrafficError);
    assert.equal(err.kind, kind);
    assert.match(err.message, message);
    return true;
  });
  await fails('bad', 'auth', /rejected the API key: You are missing valid authentication credentials/);
  await fails('limited', 'rate_limit', /rate limit/);
  await fails('broken', 'unavailable', /answered 500/);
  await fails('slow', 'timeout', /within 300 ms/);
  const unreachable = createTomTomTrafficProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9', zoom: 10, timeoutMs: 300 });
  await assert.rejects(unreachable.fetchFlow({ lat: 1, lng: 2 }), { kind: 'unavailable' });
  assert.throws(() => createTomTomTrafficProvider({ apiKey: null }), /TOMTOM_API_KEY/);
});

/** A DB with two lots and a provider whose answers the test controls. */
function setup() {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO parking_spots (id, name, address, lat, lng) VALUES (1, 'A', 'a', 28.63, 77.21), (2, 'B', 'b', 28.64, 77.22);`);
  let now = T0;
  const calls = [];
  let answer = () => ({ currentSpeed: 30, freeFlowSpeed: 60, confidence: 0.9, roadClosure: false });
  const provider = { name: 'fake', fetchFlow: async (point) => { calls.push(point); return answer(); } };
  const warnings = [];
  const updater = createTrafficUpdater(provider, TRAFFIC, { warn: (m) => warnings.push(m) });
  return {
    db, calls, warnings, clock: () => now, advance: (ms) => { now += ms; },
    setAnswer: (fn) => { answer = fn; },
    refresh: (ids) => updater.refresh(db, ids, () => now),
    read: (id) => readTraffic(db, id, now, TRAFFIC),
  };
}

test('readings are cached per lot and refreshed only once they are older than TRAFFIC_CACHE_SECONDS', async () => {
  const ctx = setup();
  await ctx.refresh([1, 2]);
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls[0], { lat: 28.63, lng: 77.21 });
  const reading = ctx.read(1);
  assert.deepEqual([reading.source, reading.congestion, reading.fresh, reading.fetchedAt], ['fake', 0.5, true, T0]);

  ctx.advance(599_000);
  await ctx.refresh([1, 2]);
  assert.equal(ctx.calls.length, 2, 'still fresh, no new calls');
  ctx.advance(1000);
  ctx.setAnswer(() => ({ currentSpeed: 54, freeFlowSpeed: 60, confidence: 1, roadClosure: false }));
  await ctx.refresh([1]);
  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.read(1).congestion.toFixed(2), '0.10');
  assert.equal(ctx.read(2).congestion, 0.5); // lot 2 wasn't asked about
  assert.equal(ctx.read(2).fresh, false);
});

test('concurrent requests for the same lot share one provider call', async () => {
  const ctx = setup();
  await Promise.all([ctx.refresh([1]), ctx.refresh([1]), ctx.refresh([1, 2])]);
  assert.equal(ctx.calls.length, 2);
});

test('when the provider fails, the last reading is used until TRAFFIC_STALE_SECONDS, and calls pause for TRAFFIC_RETRY_SECONDS', async () => {
  const ctx = setup();
  await ctx.refresh([1]);
  ctx.advance(700_000);
  ctx.setAnswer(() => { throw new TrafficError('rate_limit', 'TomTom rate limit reached'); });
  await ctx.refresh([1]); // does not throw
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.read(1).congestion, 0.5, 'old reading still prices the lot');
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /rate limit reached.*retrying in 120 s/);

  ctx.advance(60_000);
  await ctx.refresh([1, 2]);
  assert.equal(ctx.calls.length, 2, 'paused after the failure');
  ctx.advance(61_000);
  await ctx.refresh([1]);
  assert.equal(ctx.calls.length, 3, 'tries again after TRAFFIC_RETRY_SECONDS');
  assert.equal(ctx.warnings.length, 1, 'the same failure is reported once');

  ctx.advance(3600_000);
  assert.equal(ctx.read(1), null, 'too old to price with');
});

test('no reading at all, or a provider with no data for the road, leaves the lot unpriced by traffic', async () => {
  const ctx = setup();
  ctx.setAnswer(() => null);
  await ctx.refresh([1]);
  assert.equal(ctx.read(1), null);
  const none = createTrafficUpdater(createNoTrafficProvider(), TRAFFIC);
  await none.refresh(ctx.db, [1, 2], ctx.clock);
  assert.equal(ctx.read(2), null);
});

test('over HTTP, live congestion raises lot prices, and a hold charges the price shown', async (t) => {
  const setupLots = (db) => {
    db.exec(`
      INSERT INTO parking_spots (id, name, address, lat, lng) VALUES (1, 'Jammed', 'a', 10, 20), (2, 'Clear', 'b', 10.001, 20);
      INSERT INTO slots (spot_id, label) VALUES (1, 'A1'), (1, 'A2'), (2, 'A1'), (2, 'A2');
    `);
  };
  const calls = [];
  // Jammed lot: 14 km/h where traffic normally does 70. Clear lot: free-flowing.
  const traffic = {
    name: 'fake',
    fetchFlow: async ({ lat }) => {
      calls.push(lat);
      return lat === 10 ? { currentSpeed: 14, freeFlowSpeed: 70, confidence: 1, roadClosure: false }
        : { currentSpeed: 70, freeFlowSpeed: 70, confidence: 1, roadClosure: false };
    },
  };
  const { call } = await startServer(t, { setup: setupLots, traffic });
  const plain = await startServer(t, { setup: setupLots }); // no traffic provider

  const { spots } = (await call('/api/spots?lat=10&lng=20')).body;
  const [jammed, clear] = spots;
  assert.equal(jammed.name, 'Jammed');
  assert.deepEqual([jammed.pricing.traffic.level, jammed.pricing.traffic.congestion], ['severe', 0.8]);
  assert.deepEqual([clear.pricing.traffic.level, clear.pricing.traffic.congestion], ['light', 0]);
  assert.equal(jammed.pricing.traffic.source, 'fake');
  assert.equal(jammed.pricing.capacity.slots, 2);
  assert.ok(jammed.hourly_rate > clear.hourly_rate);
  const unpriced = (await plain.call('/api/spots?lat=10&lng=20')).body.spots;
  assert.equal(unpriced[1].hourly_rate, clear.hourly_rate, 'free-flowing traffic adds nothing');
  assert.equal(unpriced[0].pricing.traffic.level, 'unknown');
  assert.equal((await plain.call('/api/config')).body.trafficProvider, 'none');
  assert.equal((await call('/api/config')).body.trafficProvider, 'fake');

  const detail = (await call('/api/spots/1?hours=2')).body;
  assert.equal(detail.hourly_rate, jammed.hourly_rate);
  assert.equal(calls.length, 2, 'the cached readings were reused');

  const { token } = (await call('/api/auth/register', { method: 'POST', body: { name: 'D', email: 'd@test.dev', password: 'password1' } })).body;
  const hold = (await call('/api/bookings', { token, method: 'POST', body: { slotId: 1, startAt: Date.now(), hours: 2 } })).body;
  assert.equal(hold.amount, 2 * jammed.hourly_rate);
  assert.equal((await call('/api/bookings', { token, method: 'POST', body: { slotId: 999, startAt: Date.now(), hours: 1 } })).status, 404);
});
