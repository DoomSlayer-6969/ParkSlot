import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newPassToken } from './services/passes.js';

// Times are epoch milliseconds; money is in the currency's smallest unit.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- Only a SHA-256 hash of each reset token is stored, so a leaked DB cannot be used to reset passwords.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS parking_spots (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  hourly_rate INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spots_lat_lng ON parking_spots(lat, lng);

CREATE TABLE IF NOT EXISTS slots (
  id      INTEGER PRIMARY KEY,
  spot_id INTEGER NOT NULL REFERENCES parking_spots(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,
  UNIQUE (spot_id, label)
);

CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY,
  code            TEXT UNIQUE,          -- booking reference, issued only once payment succeeds
  checkin_token   TEXT,                 -- secret behind the driver's QR pass, issued with the code
  slot_id         INTEGER NOT NULL REFERENCES slots(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL,
  hours           INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'checked_in', 'cancelled')),
  hold_expires_at INTEGER,              -- set while status = 'pending_payment'
  checked_in_at   INTEGER,
  checkin_method  TEXT CHECK (checkin_method IN ('qr', 'manual')),
  checked_in_by   INTEGER REFERENCES users(id),  -- the admin who scanned the pass or checked in manually
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot_time ON bookings(slot_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  booking_id   INTEGER NOT NULL REFERENCES bookings(id),
  amount       INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'refunded')),
  provider_ref TEXT,
  card_last4   TEXT,
  created_at   INTEGER NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// Brings databases created by older versions up to the current schema.
function migrate(db) {
  if (!columnsOf(db, 'users').includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))");
  }

  // QR check-in passes.
  const bookingColumns = columnsOf(db, 'bookings');
  if (!bookingColumns.includes('checkin_token')) db.exec('ALTER TABLE bookings ADD COLUMN checkin_token TEXT');
  if (!bookingColumns.includes('checkin_method')) {
    db.exec("ALTER TABLE bookings ADD COLUMN checkin_method TEXT CHECK (checkin_method IN ('qr', 'manual'))");
  }
  if (!bookingColumns.includes('checked_in_by')) {
    db.exec('ALTER TABLE bookings ADD COLUMN checked_in_by INTEGER REFERENCES users(id)');
  }
  // Here rather than in SCHEMA, which runs before the column exists on older databases.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_checkin_token ON bookings(checkin_token)');
  // Bookings paid before passes existed get one, so their drivers can still check in.
  const unissued = db.prepare('SELECT id FROM bookings WHERE code IS NOT NULL AND checkin_token IS NULL').all();
  if (unissued.length) {
    transaction(db, () => {
      const issue = db.prepare('UPDATE bookings SET checkin_token = ? WHERE id = ?');
      for (const { id } of unissued) issue.run(newPassToken(), id);
    });
  }
}

// BEGIN IMMEDIATE takes the write lock up front, so a check-then-insert inside
// `fn` cannot interleave with another writer (even from another process).
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
