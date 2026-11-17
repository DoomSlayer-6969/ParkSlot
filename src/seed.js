// Demo data: a parking lot near every metro station in STATIONS_FILE (Delhi by default), at a random
// spot SEED_LOT_MIN_DISTANCE_M–SEED_LOT_MAX_DISTANCE_M from the station, with a random number of slots.
// Other (demo) drivers' bookings fill SEED_OCCUPANCY of the slots, so lots show booked and occupied slots.
// The layout comes from a seeded PRNG (SEED_RANDOM_SEED), so it is the same on every run.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { config, DAY_MS, HOUR_MS } from './config.js';
import { openDb, transaction } from './db.js';
import { createAccount, hasAdmin } from './services/auth.js';
import { newPassToken } from './services/passes.js';
import { priceFor } from './services/pricing.js';
import { distanceKm } from './services/spots.js';
import { loadStations } from './stations.js';

export const DEMO_USER = config.seed.demoDriver;
export const DEMO_ADMIN = config.seed.demoAdmin;
// Owns the background bookings. Its password is random: nobody signs in as it.
const OTHER_DRIVERS = { name: 'Other drivers (demo)', email: 'other-drivers@parking.test' };

/** Creates the demo admin account if there is no admin yet. Returns true if it did. */
export function ensureDemoAdmin(db, now = Date.now()) {
  if (hasAdmin(db)) return false;
  createAccount(db, { ...DEMO_ADMIN, role: 'admin' }, now);
  return true;
}

const LOT_NAMES = ['Metro Parking', 'Park & Ride', 'Multilevel Parking', 'Market Parking', 'Public Parking'];
const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Small deterministic PRNG so every seed run produces the same layout.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point `metres` away from `from` on compass `bearing` (radians, 0 = north). */
function offset(from, metres, bearing) {
  const dLat = (metres * Math.cos(bearing)) / 110_574;
  const dLng = (metres * Math.sin(bearing)) / (111_320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

const slotLabel = (n) => `${String.fromCharCode(65 + Math.floor(n / 10))}${(n % 10) + 1}`;

function findOrCreateUser(db, account, now) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(account.email.toLowerCase());
  if (existing) return existing.id;
  return createAccount(db, { password: randomBytes(18).toString('base64url'), ...account, role: 'user' }, now).id;
}

/**
 * Seeds lots near the metro stations, the demo driver (with an upcoming booking and a past one, near
 * the map's default centre), and other drivers' bookings. Options default to config.seed.
 */
export function seedDemoData(db, {
  stations = loadStations(config.stations.file),
  options = config.seed,
  center = config.defaultCenter,
  now = Date.now(),
} = {}) {
  const rand = mulberry32(options.randomSeed);
  const between = (min, max) => min + rand() * (max - min);
  const intBetween = (min, max) => Math.floor(between(min, max + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];

  return transaction(db, () => {
    const insertSpot = db.prepare('INSERT INTO parking_spots (name, address, lat, lng) VALUES (?, ?, ?, ?)');
    const insertSlot = db.prepare('INSERT INTO slots (spot_id, label) VALUES (?, ?)');
    const insertBooking = db.prepare(`
      INSERT INTO bookings
        (code, slot_id, user_id, start_at, end_at, hours, amount, status, checked_in_at, created_at, checkin_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPayment = db.prepare(`
      INSERT INTO payments (booking_id, amount, status, provider_ref, card_last4, created_at)
      VALUES (?, ?, 'succeeded', ?, '4242', ?)
    `);
    let codeSeq = 0;
    // Demo bookings are paid, so each gets the reference, QR pass token and payment record a real checkout
    // would leave. Pass tokens are secrets, so they come from crypto rather than the seeded PRNG.
    const book = ({ slotId, userId, start, hours, amount, status, checkedInAt = null, createdAt = now }) => {
      const code = `PK-DEMO-${String(++codeSeq).padStart(4, '0')}`;
      const { lastInsertRowid } = insertBooking.run(
        code, slotId, userId, start, start + hours * HOUR_MS, hours, amount, status, checkedInAt, createdAt, newPassToken(),
      );
      insertPayment.run(lastInsertRowid, amount, `mock_ch_demo_${lastInsertRowid}`, createdAt);
    };

    const demoDriverId = findOrCreateUser(db, DEMO_USER, now);
    const otherDriversId = findOrCreateUser(db, OTHER_DRIVERS, now);

    // Lots: one or more near each station.
    const lots = [];
    for (const station of stations) {
      for (let i = 0; i < options.lotsPerStation; i++) {
        const bearing = rand() * 2 * Math.PI;
        const metres = Math.round(between(options.lotMinDistanceM, options.lotMaxDistanceM));
        const { lat, lng } = offset(station, metres, bearing);
        const direction = DIRECTIONS[Math.round(bearing / (Math.PI / 4)) % 8];
        const suffix = options.lotsPerStation > 1 ? ` ${String.fromCharCode(65 + i)}` : '';
        const name = `${station.name} ${pick(LOT_NAMES)}${suffix}`;
        const address = `${metres} m ${direction} of ${station.name} metro station (demo)`;
        const spotId = Number(insertSpot.run(name, address, lat, lng).lastInsertRowid);
        const capacity = intBetween(options.lotMinSlots, options.lotMaxSlots);
        const slotIds = Array.from({ length: capacity }, (_, n) => Number(insertSlot.run(spotId, slotLabel(n)).lastInsertRowid));
        lots.push({ spotId, slotIds, capacity, lat, lng });
      }
    }

    // The demo driver's own bookings, at the two lots nearest the map's default centre: one coming up
    // later today (it has a QR pass) and one used yesterday (in their history). Their slots are kept free
    // of background bookings.
    const nearest = [...lots].sort((a, b) => distanceKm(center, a) - distanceKm(center, b));
    const reserved = new Set();
    const rateOf = (lot) => priceFor({ slots: lot.capacity }).hourly_rate; // no traffic data at seed time
    if (nearest[0]) {
      const slotId = nearest[0].slotIds[0];
      reserved.add(slotId);
      book({ slotId, userId: demoDriverId, start: now + 2 * HOUR_MS, hours: 2, amount: rateOf(nearest[0]) * 2, status: 'confirmed' });
    }
    if (nearest[1]) {
      const slotId = nearest[1].slotIds[0];
      const start = now - DAY_MS;
      reserved.add(slotId);
      book({
        slotId, userId: demoDriverId, start, hours: 3, amount: rateOf(nearest[1]) * 3,
        status: 'checked_in', checkedInAt: start + 10 * 60_000, createdAt: start - HOUR_MS,
      });
    }

    // Other drivers: parked now, paid and arriving now, or booked for later today.
    let background = 0;
    for (const lot of lots) {
      const rate = rateOf(lot);
      for (const slotId of lot.slotIds) {
        if (reserved.has(slotId) || rand() >= options.occupancy) continue;
        const kind = rand();
        const userId = otherDriversId;
        if (kind < 0.45) {
          const start = now - HOUR_MS;
          book({ slotId, userId, start, hours: 3, amount: rate * 3, status: 'checked_in', checkedInAt: start });
        } else if (kind < 0.8) {
          book({ slotId, userId, start: now, hours: 2, amount: rate * 2, status: 'confirmed' });
        } else {
          book({ slotId, userId, start: now + 3 * HOUR_MS, hours: 2, amount: rate * 2, status: 'confirmed' });
        }
        background++;
      }
    }
    return { lots: lots.length, slots: lots.reduce((n, l) => n + l.capacity, 0), stations: stations.length, background };
  });
}

export function hasSpots(db) {
  return Boolean(db.prepare('SELECT 1 FROM parking_spots LIMIT 1').get());
}

// CLI: npm run seed [-- --reset]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
  const db = openDb(config.dbFile);
  if (values.reset) {
    // Traffic readings go with their lots (ON DELETE CASCADE).
    db.exec('DELETE FROM payments; DELETE FROM bookings; DELETE FROM slots; DELETE FROM parking_spots;');
  } else if (hasSpots(db)) {
    console.error('The database already has parking lots. Use npm run seed -- --reset to replace them (this deletes all bookings).');
    process.exit(1);
  }
  const result = seedDemoData(db);
  console.log(`Seeded ${result.lots} parking lots (${result.slots} slots) near ${result.stations} metro stations, with ${result.background} bookings by other drivers.`);
  console.log(`Demo driver: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  if (ensureDemoAdmin(db)) console.log(`Created demo admin: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
}
