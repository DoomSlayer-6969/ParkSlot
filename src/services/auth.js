// Accounts, roles, passwords and sessions. Password reset lives in password-reset.js.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config, DAY_MS } from '../config.js';
import { HttpError } from '../errors.js';
import { welcomeEmail } from './emails.js';
import { sendInBackground } from './mailer.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
export const isValidEmail = (email) => EMAIL_RE.test(email);

export function validatePassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

// Each role signs in to its own portal: drivers at /, admins at /admin/.
export const ROLES = ['user', 'admin'];

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

export function createSession(db, userId, now) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, now + config.sessionDays * DAY_MS);
  return token;
}

/** Validates and inserts an account. Does not start a session. */
export function createAccount(db, { name, email, password, role = 'user' }, now) {
  name = String(name ?? '').trim();
  email = normalizeEmail(email);
  password = String(password ?? '');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
  if (!name) throw new HttpError(400, 'Name is required');
  if (!isValidEmail(email)) throw new HttpError(400, 'A valid email is required');
  validatePassword(password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, hashPassword(password), role, now);
  return { id: Number(lastInsertRowid), name, email, role };
}

/**
 * Public sign-up. Always creates a driver account; admins are created from the CLI.
 * With a `mailer`, a welcome email goes out once the account exists. Sign-up never waits for it or fails because of it.
 */
export function register(db, { name, email, password }, now, mailer = null) {
  const user = createAccount(db, { name, email, password, role: 'user' }, now);
  const session = { token: createSession(db, user.id, now), user };
  if (mailer) sendInBackground(mailer, welcomeEmail(user));
  return session;
}

/** Signs in to the portal for `role`. Accounts of the other role are turned away. */
export function login(db, { email, password }, now, role = 'user') {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
  if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
    throw new HttpError(401, 'Incorrect email or password');
  }
  if (row.role !== role) {
    throw new HttpError(403, row.role === 'admin'
      ? 'This is an admin account. Sign in at the admin portal (/admin/).'
      : 'This account does not have admin access.');
  }
  const user = { id: row.id, name: row.name, email: row.email, role: row.role };
  return { token: createSession(db, row.id, now), user };
}

export function userForToken(db, token, now) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);
}

export function hasAdmin(db) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());
}

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
