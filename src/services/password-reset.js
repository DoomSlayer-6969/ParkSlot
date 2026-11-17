// Password reset for driver accounts. Admin passwords are managed from the CLI.
import { createHash, randomBytes } from 'node:crypto';
import { config, MINUTE_MS } from '../config.js';
import { transaction } from '../db.js';
import { HttpError } from '../errors.js';
import { createSession, hashPassword, isValidEmail, normalizeEmail, validatePassword } from './auth.js';
import { passwordResetEmail } from './emails.js';
import { sendInBackground } from './mailer.js';

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
  if (!isValidEmail(email)) throw new HttpError(400, 'A valid email is required');

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

  sendInBackground(mailer, passwordResetEmail({ name: issued.name, email }, issued.token));
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
