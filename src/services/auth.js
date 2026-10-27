import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config, DAY_MS } from '../config.js';
import { HttpError } from '../errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

function createSession(db, userId, now) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, now + config.sessionDays * DAY_MS);
  return token;
}

export function register(db, { name, email, password }, now) {
  name = String(name ?? '').trim();
  email = String(email ?? '').trim().toLowerCase();
  password = String(password ?? '');
  if (!name) throw new HttpError(400, 'Name is required');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'A valid email is required');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(name, email, hashPassword(password), now);
  const user = { id: Number(lastInsertRowid), name, email };
  return { token: createSession(db, user.id, now), user };
}

export function login(db, { email, password }, now) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
  if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
    throw new HttpError(401, 'Incorrect email or password');
  }
  return { token: createSession(db, row.id, now), user: { id: row.id, name: row.name, email: row.email } };
}

export function userForToken(db, token, now) {
  return db.prepare(`
    SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);
}

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
