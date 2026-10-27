import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { config, HOUR_MS } from './config.js';
import { openDb, transaction } from './db.js';
import { hashPassword } from './services/auth.js';

export const DEMO_USER = { name: 'Demo User', email: 'demo@parking.test', password: 'demo1234' };

const SPOT_NAMES = [
  'Central Plaza Parking', 'Metro Station Lot', 'City Mall Basement', 'Riverside Parking',
  'Market Street Garage', 'Tech Park P2', 'Hospital Visitor Parking', 'Stadium Lot B',
  'Public Library Parking', 'Old Town Garage', 'Lakeside Lot', 'Convention Centre Parking',
];
const CAPACITIES = [6, 8, 10, 12, 16, 20];
const HOURLY_RATES = [20, 30, 40, 50, 60]; // major currency units
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

/** Seeds demo spots around `center`, a demo user, and a few bookings so every slot status is visible. */
export function seedDemoData(db, center, now = Date.now()) {
  const rand = mulberry32(42);
  const pick = (list) => list[Math.floor(rand() * list.length)];

  transaction(db, () => {
    const insertSpot = db.prepare('INSERT INTO parking_spots (name, address, lat, lng, hourly_rate) VALUES (?, ?, ?, ?, ?)');
    const insertSlot = db.prepare('INSERT INTO slots (spot_id, label) VALUES (?, ?)');
    const insertBooking = db.prepare(`
      INSERT INTO bookings (code, slot_id, user_id, start_at, end_at, hours, amount, status, checked_in_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let user = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_USER.email);
    if (!user) {
      const { lastInsertRowid } = db.prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(DEMO_USER.name, DEMO_USER.email, hashPassword(DEMO_USER.password), now);
      user = { id: Number(lastInsertRowid) };
    }

    let codeSeq = 0;
    SPOT_NAMES.forEach((name, i) => {
      // Spread spots 0.3-4 km from the centre in all directions.
      const bearing = (i / SPOT_NAMES.length) * 2 * Math.PI + rand() * 0.5;
      const distKm = 0.3 + rand() * 3.7;
      const lat = center.lat + (distKm * Math.cos(bearing)) / 111.32;
      const lng = center.lng + (distKm * Math.sin(bearing)) / (111.32 * Math.cos((center.lat * Math.PI) / 180));
      const direction = DIRECTIONS[Math.round(((bearing * 180) / Math.PI / 45)) % 8];
      const rate = pick(HOURLY_RATES) * 100;

      const spotId = Number(insertSpot.run(name, `${distKm.toFixed(1)} km ${direction} of centre (demo)`, lat, lng, rate).lastInsertRowid);
      const capacity = pick(CAPACITIES);
      for (let n = 0; n < capacity; n++) {
        const label = `${String.fromCharCode(65 + Math.floor(n / 10))}${(n % 10) + 1}`;
        const slotId = Number(insertSlot.run(spotId, label).lastInsertRowid);

        const roll = rand();
        const code = () => `PK-DEMO-${String(++codeSeq).padStart(4, '0')}`;
        if (roll < 0.2) {
          // Parked right now.
          const start = now - HOUR_MS;
          insertBooking.run(code(), slotId, user.id, start, start + 3 * HOUR_MS, 3, rate * 3, 'checked_in', start, now);
        } else if (roll < 0.35) {
          // Paid for, driver not arrived yet.
          insertBooking.run(code(), slotId, user.id, now, now + 2 * HOUR_MS, 2, rate * 2, 'confirmed', null, now);
        } else if (roll < 0.45) {
          // Free now, booked later today.
          const start = now + 3 * HOUR_MS;
          insertBooking.run(code(), slotId, user.id, start, start + 2 * HOUR_MS, 2, rate * 2, 'confirmed', null, now);
        }
      }
    });
  });
}

export function hasSpots(db) {
  return Boolean(db.prepare('SELECT 1 FROM parking_spots LIMIT 1').get());
}

// CLI: npm run seed -- [--lat 12.97 --lng 77.59] [--reset]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { lat: { type: 'string' }, lng: { type: 'string' }, reset: { type: 'boolean', default: false } },
  });
  const center = {
    lat: values.lat ? Number(values.lat) : config.defaultCenter.lat,
    lng: values.lng ? Number(values.lng) : config.defaultCenter.lng,
  };
  const db = openDb(config.dbFile);
  if (values.reset) db.exec('DELETE FROM payments; DELETE FROM bookings; DELETE FROM slots; DELETE FROM parking_spots;');
  seedDemoData(db, center);
  console.log(`Seeded ${SPOT_NAMES.length} demo parking spots around ${center.lat}, ${center.lng}`);
}
