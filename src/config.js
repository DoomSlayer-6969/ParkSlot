// Every setting comes from the environment, with the defaults below. `.env.example` lists them all.
// Invalid values stop start-up with a message naming the variable, rather than misbehaving later.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const env = process.env;
const isSet = (name) => env[name] !== undefined && env[name] !== '';

/** A numeric setting. `integer` requires a whole number; `min`/`max` bound it. */
function num(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (!isSet(name)) return fallback;
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    const range = [Number.isFinite(min) && `at least ${min}`, Number.isFinite(max) && `at most ${max}`].filter(Boolean).join(' and ');
    throw new Error(`${name} must be ${integer ? 'a whole number' : 'a number'}${range ? ` ${range}` : ''} (got "${env[name]}")`);
  }
  return value;
}

const str = (name, fallback = null) => (isSet(name) ? env[name] : fallback);

function choice(name, options, fallback) {
  const value = str(name, fallback);
  if (!options.includes(value)) throw new Error(`${name} must be one of: ${options.join(', ')} (got "${value}")`);
  return value;
}

/** Comma-separated increasing numbers, e.g. "0.15,0.35,0.6". */
function numberList(name, fallback) {
  if (!isSet(name)) return fallback;
  const values = env[name].split(',').map((v) => Number(v.trim()));
  if (values.some((v) => !Number.isFinite(v)) || values.some((v, i) => i > 0 && v <= values[i - 1])) {
    throw new Error(`${name} must be comma-separated increasing numbers (got "${env[name]}")`);
  }
  return values;
}

const projectFile = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

const port = num('PORT', 3000, { min: 0, max: 65535, integer: true });
const dbFile = str('DB_FILE', projectFile('data/parking.db'));
const tomtomApiKey = str('TOMTOM_API_KEY');

export const config = {
  port,
  // Base URL for links in emails.
  publicUrl: str('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
  // Outgoing email. With no SMTP_HOST, emails are printed to the console instead (development).
  smtp: {
    host: str('SMTP_HOST'),
    port: num('SMTP_PORT', 587, { min: 1, max: 65535, integer: true }),
    // Implicit TLS (usually port 465). Otherwise STARTTLS is used when the server offers it.
    secure: isSet('SMTP_SECURE') ? env.SMTP_SECURE === 'true' : num('SMTP_PORT', 587) === 465,
    user: str('SMTP_USER'),
    pass: str('SMTP_PASS'),
  },
  // Sender of every email, e.g. "ParkSlot <no-reply@example.com>". Required when SMTP is configured.
  mailFrom: str('MAIL_FROM'),
  dbFile,
  // Optional second listener with TLS, for local development: browsers only allow the camera (the admin
  // QR scanner) on https:// or http://localhost, so phones on the same network need HTTPS.
  httpsPort: isSet('HTTPS_PORT') ? num('HTTPS_PORT', null, { min: 0, max: 65535, integer: true }) : null,
  // Your own certificate and key (PEM). Without them, a self-signed one is generated in tlsDir.
  tlsCertFile: str('TLS_CERT_FILE'),
  tlsKeyFile: str('TLS_KEY_FILE'),
  // Generated certificates live next to the database (data/tls/ by default).
  tlsDir: join(dirname(dbFile), 'tls'),

  // ISO 4217 code; all amounts are stored in the currency's smallest unit (paise, cents...).
  currency: str('CURRENCY', 'INR'),

  // ---- Map and search (sent to the browser through /api/config)
  // Where the map opens: Connaught Place / Rajiv Chowk metro, New Delhi.
  defaultCenter: {
    lat: num('DEFAULT_LAT', 28.6315, { min: -90, max: 90 }),
    lng: num('DEFAULT_LNG', 77.2167, { min: -180, max: 180 }),
  },
  searchRadiusKm: num('SEARCH_RADIUS_KM', 3, { min: 0.1 }),
  maxSearchRadiusKm: num('MAX_SEARCH_RADIUS_KM', 20, { min: 0.1 }),
  mapTileUrl: str('MAP_TILE_URL', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  mapAttribution: str('MAP_ATTRIBUTION', '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
  // Place search (Nominatim-compatible). Country codes narrow results, e.g. "in"; empty means worldwide.
  geocoderUrl: str('GEOCODER_URL', 'https://nominatim.openstreetmap.org/search'),
  geocoderCountryCodes: str('GEOCODER_COUNTRY_CODES', 'in'),

  // ---- Booking rules
  // How long a slot stays reserved while the user completes payment.
  holdMinutes: num('HOLD_MINUTES', 10, { min: 1 }),
  maxHours: num('MAX_BOOKING_HOURS', 24, { min: 1, integer: true }),
  maxAdvanceDays: num('MAX_ADVANCE_DAYS', 7, { min: 0 }),
  // A start time this far in the past is treated as "now" (form round-trips take time).
  startGraceMinutes: num('START_GRACE_MINUTES', 15, { min: 0 }),

  // ---- Accounts
  sessionDays: num('SESSION_DAYS', 7, { min: 0.01 }),
  // Password reset links work once and expire after this long.
  resetTokenMinutes: num('RESET_TOKEN_MINUTES', 30, { min: 1 }),
  // At most one reset email per account in this window, so the form cannot be used to flood an inbox.
  resetCooldownSeconds: num('RESET_COOLDOWN_SECONDS', 60, { min: 0 }),

  // ---- Booking lists are paged
  pageSize: num('PAGE_SIZE', 20, { min: 1, integer: true }),
  maxPageSize: num('MAX_PAGE_SIZE', 100, { min: 1, integer: true }),

  // ---- Pricing (amounts in the currency's smallest unit). See services/pricing.js for the formula:
  // hourly rate = base × traffic factor × lot-size factor, rounded, then kept within [min, max].
  pricing: {
    baseHourlyRate: num('BASE_HOURLY_RATE', 3000, { min: 0, integer: true }),
    // Traffic factor = 1 + weight × congestion (0 = free-flowing, 1 = standstill or road closed).
    trafficWeight: num('TRAFFIC_PRICE_WEIGHT', 1, { min: 0 }),
    // Lot-size factor = (reference slots / lot slots) ^ elasticity: small lots cost more, big ones less.
    capacityReferenceSlots: num('CAPACITY_REFERENCE_SLOTS', 20, { min: 1 }),
    capacityElasticity: num('CAPACITY_PRICE_ELASTICITY', 0.35, { min: 0 }),
    rounding: num('PRICE_ROUNDING', 500, { min: 1, integer: true }),
    minHourlyRate: num('MIN_HOURLY_RATE', 1000, { min: 0, integer: true }),
    maxHourlyRate: num('MAX_HOURLY_RATE', 20000, { min: 0, integer: true }),
  },

  // ---- Live traffic (services/traffic.js). With no provider, prices carry no traffic surcharge.
  traffic: {
    provider: choice('TRAFFIC_PROVIDER', ['tomtom', 'none'], tomtomApiKey ? 'tomtom' : 'none'),
    tomtom: {
      apiKey: tomtomApiKey,
      baseUrl: str('TOMTOM_BASE_URL', 'https://api.tomtom.com').replace(/\/+$/, ''),
      // Zoom level of the road network to match against (0-22); 10 matches main roads, higher includes smaller ones.
      zoom: num('TOMTOM_FLOW_ZOOM', 10, { min: 0, max: 22, integer: true }),
    },
    // A lot's reading is refreshed when it is older than this and someone looks at the lot.
    cacheSeconds: num('TRAFFIC_CACHE_SECONDS', 600, { min: 0 }),
    // If refreshing fails, an older reading is still used for prices up to this age; after that, none.
    staleSeconds: num('TRAFFIC_STALE_SECONDS', 3600, { min: 0 }),
    timeoutMs: num('TRAFFIC_TIMEOUT_MS', 5000, { min: 100 }),
    // After the provider fails (rate limit, bad key, outage), wait this long before calling it again.
    retrySeconds: num('TRAFFIC_RETRY_SECONDS', 120, { min: 0 }),
    // Congestion at or above each threshold makes the level moderate, heavy, severe.
    levelThresholds: numberList('TRAFFIC_LEVELS', [0.15, 0.35, 0.6]),
  },

  // ---- Metro stations (the demo seed puts parking lots near them; `npm run fetch-stations` refreshes them)
  stations: {
    file: str('STATIONS_FILE', projectFile('src/data/delhi-metro-stations.json')),
    overpassUrl: str('OVERPASS_URL', 'https://overpass-api.de/api/interpreter'),
    area: str('STATIONS_AREA', 'Delhi'),
    // OpenStreetMap admin_level of the area: 4 is a state or union territory such as the NCT of Delhi.
    areaAdminLevel: num('STATIONS_AREA_ADMIN_LEVEL', 4, { min: 1, max: 11, integer: true }),
  },

  // ---- Demo data (`npm start` seeds an empty DB; `npm run seed -- --reset` reseeds)
  seed: {
    randomSeed: num('SEED_RANDOM_SEED', 42, { integer: true }),
    lotsPerStation: num('SEED_LOTS_PER_STATION', 1, { min: 0, integer: true }),
    lotMinDistanceM: num('SEED_LOT_MIN_DISTANCE_M', 80, { min: 0 }),
    lotMaxDistanceM: num('SEED_LOT_MAX_DISTANCE_M', 450, { min: 0 }),
    // Slot labels run A1…Z10, so at most 260 slots per lot.
    lotMinSlots: num('SEED_LOT_MIN_SLOTS', 6, { min: 1, max: 260, integer: true }),
    lotMaxSlots: num('SEED_LOT_MAX_SLOTS', 40, { min: 1, max: 260, integer: true }),
    // Share of slots given a booking by other (demo) drivers, so lots show booked and occupied slots.
    occupancy: num('SEED_OCCUPANCY', 0.4, { min: 0, max: 1 }),
    demoDriver: {
      name: str('DEMO_DRIVER_NAME', 'Demo User'),
      email: str('DEMO_DRIVER_EMAIL', 'demo@parking.test'),
      password: str('DEMO_DRIVER_PASSWORD', 'demo1234'),
    },
    demoAdmin: {
      name: str('DEMO_ADMIN_NAME', 'Demo Admin'),
      email: str('DEMO_ADMIN_EMAIL', 'admin@parking.test'),
      password: str('DEMO_ADMIN_PASSWORD', 'admin1234'),
    },
  },
};

// Cross-field checks.
if (config.maxSearchRadiusKm < config.searchRadiusKm) throw new Error('MAX_SEARCH_RADIUS_KM must be at least SEARCH_RADIUS_KM');
if (config.maxPageSize < config.pageSize) throw new Error('MAX_PAGE_SIZE must be at least PAGE_SIZE');
if (config.pricing.maxHourlyRate < config.pricing.minHourlyRate) throw new Error('MAX_HOURLY_RATE must be at least MIN_HOURLY_RATE');
if (config.seed.lotMaxDistanceM < config.seed.lotMinDistanceM) throw new Error('SEED_LOT_MAX_DISTANCE_M must be at least SEED_LOT_MIN_DISTANCE_M');
if (config.seed.lotMaxSlots < config.seed.lotMinSlots) throw new Error('SEED_LOT_MAX_SLOTS must be at least SEED_LOT_MIN_SLOTS');
if (config.traffic.provider === 'tomtom' && !tomtomApiKey) throw new Error('TRAFFIC_PROVIDER=tomtom needs TOMTOM_API_KEY');
