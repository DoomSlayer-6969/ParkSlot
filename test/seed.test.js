import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { getPassPayload } from '../src/services/checkin.js';
import { listUserBookings } from '../src/services/bookings.js';
import { priceFor } from '../src/services/pricing.js';
import { DEMO_USER, seedDemoData } from '../src/seed.js';
import { loadStations, metresBetween, overpassQuery, stationsFromOverpass } from '../src/stations.js';

const T0 = Date.UTC(2030, 0, 1, 10);
const STATIONS = [
  { name: 'Rajiv Chowk', lat: 28.632742, lng: 77.219505 },
  { name: 'Kashmere Gate', lat: 28.668061, lng: 77.22815 },
  { name: 'Hauz Khas', lat: 28.543, lng: 77.2066 },
];
const OPTIONS = {
  ...config.seed, randomSeed: 7, lotsPerStation: 2, lotMinDistanceM: 100, lotMaxDistanceM: 300,
  lotMinSlots: 4, lotMaxSlots: 12, occupancy: 0.5,
};

function seeded(options = OPTIONS) {
  const db = openDb(':memory:');
  const result = seedDemoData(db, { stations: STATIONS, options, center: STATIONS[0], now: T0 });
  return { db, result };
}

test('every metro station gets its lots, at a random spot within the configured distance', () => {
  const { db, result } = seeded();
  const lots = db.prepare('SELECT p.*, COUNT(s.id) AS slots FROM parking_spots p JOIN slots s ON s.spot_id = p.id GROUP BY p.id').all();
  assert.equal(lots.length, 6);
  assert.deepEqual(result, { lots: 6, slots: lots.reduce((n, l) => n + l.slots, 0), stations: 3, background: result.background });
  for (const lot of lots) {
    const station = STATIONS.find((s) => lot.name.startsWith(s.name));
    assert.ok(station, lot.name);
    const metres = metresBetween(station, lot);
    assert.ok(metres >= 99 && metres <= 301, `${lot.name} is ${metres} m from the station`);
    assert.match(lot.name, / [AB]$/); // two lots per station are told apart
    assert.match(lot.address, new RegExp(`^\\d+ m [NESW]{1,2} of ${station.name} metro station \\(demo\\)$`));
    assert.ok(lot.slots >= 4 && lot.slots <= 12);
  }
  assert.ok(new Set(lots.map((l) => `${l.lat},${l.lng}`)).size === 6);
});

test('the layout is the same for the same SEED_RANDOM_SEED and different for another', () => {
  const layout = (db) => db.prepare('SELECT name, lat, lng FROM parking_spots ORDER BY id').all();
  const occupancy = (db) => db.prepare('SELECT slot_id, status, start_at FROM bookings ORDER BY id').all();
  const a = seeded().db;
  const b = seeded().db;
  const c = seeded({ ...OPTIONS, randomSeed: 8 }).db;
  assert.deepEqual(layout(a), layout(b));
  assert.deepEqual(occupancy(a), occupancy(b));
  assert.notDeepEqual(layout(a), layout(c));
});

test('seeded bookings never double-book a slot, and are paid at the lot-size price', () => {
  const { db, result } = seeded();
  const overlaps = db.prepare(`
    SELECT COUNT(*) AS n FROM bookings a JOIN bookings b
      ON a.slot_id = b.slot_id AND a.id < b.id AND a.start_at < b.end_at AND b.start_at < a.end_at
  `).get().n;
  assert.equal(overlaps, 0);
  assert.ok(result.background > 0);
  const unpaid = db.prepare(`
    SELECT COUNT(*) AS n FROM bookings b LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'succeeded'
    WHERE p.id IS NULL OR p.amount != b.amount OR b.code IS NULL OR b.checkin_token IS NULL
  `).get().n;
  assert.equal(unpaid, 0);
  const wrongPrice = db.prepare(`
    SELECT b.amount, b.hours, (SELECT COUNT(*) FROM slots WHERE spot_id = s.spot_id) AS slots
    FROM bookings b JOIN slots s ON s.id = b.slot_id
  `).all().filter((b) => b.amount !== b.hours * priceFor({ slots: b.slots }).hourly_rate);
  assert.deepEqual(wrongPrice, []);
});

test('the demo driver has one upcoming booking with a QR pass near the map centre, and one in their history', () => {
  const { db } = seeded();
  const demo = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_USER.email);
  const upcoming = listUserBookings(db, demo.id, T0, { scope: 'upcoming' }).bookings;
  const history = listUserBookings(db, demo.id, T0, { scope: 'history' }).bookings;
  assert.equal(upcoming.length, 1);
  assert.equal(history.length, 1);
  assert.equal(upcoming[0].status, 'confirmed');
  assert.match(upcoming[0].spot_name, /^Rajiv Chowk /); // nearest the centre
  assert.match(getPassPayload(db, { bookingId: upcoming[0].id, userId: demo.id }, T0), /^PARKSLOT:/);
  assert.equal(history[0].status, 'completed');
  assert.equal(listUserBookings(db, demo.id, T0, { scope: 'all', limit: 100 }).bookings.length, 2, 'background bookings belong to other drivers');
});

test('stations from OpenStreetMap are merged per station, named in English and sorted', () => {
  const stations = stationsFromOverpass({
    elements: [
      { type: 'node', id: 2, lat: 28.6327, lon: 77.2195, tags: { name: 'Rajiv Chowk' } },
      { type: 'node', id: 1, lat: 28.6331, lon: 77.2197, tags: { name: 'Rajiv Chowk' } }, // other line, same station
      { type: 'way', id: 5, center: { lat: 28.70, lon: 77.16 }, tags: { name: 'Shalimar Bagh Metro Station' } },
      { type: 'node', id: 3, lat: 28.55, lon: 77.25, tags: { name: 'कालकाजी मंदिर', 'name:en': 'Kalkaji Mandir' } },
      { type: 'node', id: 4, lat: 28.75, lon: 77.30, tags: { name: 'Rajiv Chowk' } }, // far away: a different station
      { type: 'node', id: 6, lat: 28.6, lon: 77.2, tags: {} }, // unnamed
      { type: 'node', id: 7, lat: 28.5433, lon: 77.2066, tags: { name: 'Hauz Khas (Yellow Line)' } },
      { type: 'node', id: 8, lat: 28.5442, lon: 77.2071, tags: { name: 'Hauz Khas (Magenta Line)' } },
    ],
  });
  assert.deepEqual(stations.map((s) => [s.name, s.osm]), [
    ['Hauz Khas', ['node/7', 'node/8']],
    ['Kalkaji Mandir', ['node/3']],
    ['Rajiv Chowk', ['node/1', 'node/2']],
    ['Rajiv Chowk', ['node/4']],
    ['Shalimar Bagh', ['way/5']],
  ]);
  assert.deepEqual([stations[2].lat, stations[2].lng], [28.6329, 77.2196]);
  assert.match(overpassQuery('Say "hi"', 4), /area\["name"="Say \\"hi\\""\]\["admin_level"="4"\]/);
});

test('the bundled station list covers Delhi', () => {
  const stations = loadStations(config.stations.file);
  assert.ok(stations.length > 150, `${stations.length} stations`);
  for (const s of stations) assert.ok(s.lat > 28.3 && s.lat < 29 && s.lng > 76.8 && s.lng < 77.5, `${s.name} is outside Delhi`);
  for (const name of ['Rajiv Chowk', 'Kashmere Gate', 'Hauz Khas', 'New Delhi']) {
    assert.ok(stations.some((s) => s.name === name), name);
  }
  assert.throws(() => loadStations('/nonexistent/stations.json'), /npm run fetch-stations/);
});
