import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Times are epoch milliseconds; money is in the currency's smallest unit.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

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
  code            TEXT UNIQUE,          -- issued only once payment succeeds
  slot_id         INTEGER NOT NULL REFERENCES slots(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL,
  hours           INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'checked_in', 'cancelled')),
  hold_expires_at INTEGER,              -- set while status = 'pending_payment'
  checked_in_at   INTEGER,
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
  return db;
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
