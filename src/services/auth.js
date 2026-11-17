import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config, DAY_MS, MINUTE_MS } from '../config.js';
import { transaction } from '../db.js';
import { HttpError } from '../errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

function validatePassword(password) {
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

function createSession(db, userId, now) {
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
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'A valid email is required');
  validatePassword(password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, hashPassword(password), role, now);
  return { id: Number(lastInsertRowid), name, email, role };
}

/** Public sign-up. Always creates a driver account; admins are created from the CLI. */
export function register(db, { name, email, password }, now) {
  const user = createAccount(db, { name, email, password, role: 'user' }, now);
  return { token: createSession(db, user.id, now), user };
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

// ---------------------------------------------------------------- password reset (driver accounts)

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

// One message for every outcome, so the form does not reveal which emails have accounts.
export const RESET_REQUESTED_MESSAGE = 'If a driver account exists for that email, we have sent it a link to reset the password.';
const INVALID_RESET_MESSAGE = 'This reset link is invalid or has expired. Please request a new one.';

/**
 * Emails a single-use reset link to the driver account with this email, if there is one.
 * Unknown emails and admin accounts are ignored silently. Admin passwords are managed from the CLI.
 * The email is sent without waiting, so the response time does not reveal whether it was sent.
 */
export function requestPasswordReset(db, mailer, { email }, now) {
  email = normalizeEmail(email);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'A valid email is required');

  const issued = transaction(db, () => {
    db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').run(now);
    const user = db.prepare("SELECT id, name FROM users WHERE email = ? AND role = 'user'").get(email);
    if (!user) return null;
    const recent = db.prepare('SELECT 1 FROM password_resets WHERE user_id = ? AND created_at > ?')
      .get(user.id, now - config.resetCooldownSeconds * 1000);
    if (recent) return null; // a link was sent moments ago and is still valid

    // Issuing a new link cancels any older ones.
    const raw = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(raw), user.id, now, now + config.resetTokenMinutes * MINUTE_MS);
    return { token: raw, name: user.name };
  });
  if (!issued) return;

  const { token, name } = issued;
  // The token goes in the URL fragment, which browsers never send to servers or in Referer headers.
  const link = `${config.publicUrl}/#reset=${token}`;
  const message = {
    to: email,
    subject: 'Reset your ParkSlot password',
    text: [
      `Hi ${name},`,
      '',
      'Someone (hopefully you) asked to reset the password for your ParkSlot account.',
      `Choose a new password with this link. It works once and expires in ${config.resetTokenMinutes} minutes:`,
      '',
      link,
      '',
      "If you didn't ask for this, you can ignore this email. Your password has not changed.",
    ].join('\n'),
  };
  const logFailure = (err) => console.error(`Could not send password reset email to ${email}:`, err);
  try {
    Promise.resolve(mailer.send(message)).catch(logFailure);
  } catch (err) {
    logFailure(err);
  }
}

/**
 * Sets a new password using a reset token. The token is used up, every existing
 * session of the account is signed out, and a new session is returned.
 */
export function confirmPasswordReset(db, { token, password }, now) {
  password = String(password ?? '');
  validatePassword(password); // before the token is used up, so a too-short password can be retried
  const tokenHash = hashToken(String(token ?? ''));
  const passwordHash = hashPassword(password); // slow, so done before taking the write lock

  return transaction(db, () => {
    const row = db.prepare(`
      SELECT u.id, u.name, u.email, u.role FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ? AND r.expires_at > ?
    `).get(tokenHash, now);
    if (!row || row.role !== 'user') throw new HttpError(400, INVALID_RESET_MESSAGE, { reason: 'invalid_reset_token' });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    return { token: createSession(db, row.id, now), user: row };
  });
}
