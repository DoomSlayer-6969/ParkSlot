import { fileURLToPath } from 'node:url';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  dbFile: env.DB_FILE ?? fileURLToPath(new URL('../data/parking.db', import.meta.url)),
  // ISO 4217 code; all amounts are stored in the currency's smallest unit (paise, cents...).
  currency: env.CURRENCY ?? 'INR',
  // Where the map opens and where demo data is seeded.
  defaultCenter: {
    lat: Number(env.DEFAULT_LAT ?? 28.6315),
    lng: Number(env.DEFAULT_LNG ?? 77.2167),
  },
  // Shared secret for the attendant check-in screen (prototype stand-in for staff accounts).
  attendantKey: env.ATTENDANT_KEY ?? 'demo-attendant',
  // How long a slot stays reserved while the user completes payment.
  holdMinutes: 10,
  maxHours: 24,
  maxAdvanceDays: 7,
  // A start time this far in the past is treated as "now" (form round-trips take time).
  startGraceMinutes: 15,
  sessionDays: 7,
};
