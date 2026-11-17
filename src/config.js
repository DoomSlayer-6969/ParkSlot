import { fileURLToPath } from 'node:url';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const env = process.env;

const port = Number(env.PORT ?? 3000);

export const config = {
  port,
  // Base URL for links in emails.
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
  // Outgoing email. With no SMTP_HOST, emails are printed to the console instead (development).
  smtp: {
    host: env.SMTP_HOST || null,
    port: Number(env.SMTP_PORT || 587),
    // Implicit TLS (usually port 465). Otherwise STARTTLS is used when the server offers it.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : Number(env.SMTP_PORT) === 465,
    user: env.SMTP_USER || null,
    pass: env.SMTP_PASS || null,
  },
  // Sender of every email, e.g. "ParkSlot <no-reply@example.com>". Required when SMTP is configured.
  mailFrom: env.MAIL_FROM || null,
  dbFile: env.DB_FILE ?? fileURLToPath(new URL('../data/parking.db', import.meta.url)),
  // ISO 4217 code; all amounts are stored in the currency's smallest unit (paise, cents...).
  currency: env.CURRENCY ?? 'INR',
  // Where the map opens and where demo data is seeded.
  defaultCenter: {
    lat: Number(env.DEFAULT_LAT ?? 28.6315),
    lng: Number(env.DEFAULT_LNG ?? 77.2167),
  },
  // How long a slot stays reserved while the user completes payment.
  holdMinutes: 10,
  maxHours: 24,
  maxAdvanceDays: 7,
  // A start time this far in the past is treated as "now" (form round-trips take time).
  startGraceMinutes: 15,
  sessionDays: 7,
  // Password reset links work once and expire after this long.
  resetTokenMinutes: 30,
  // At most one reset email per account in this window, so the form cannot be used to flood an inbox.
  resetCooldownSeconds: 60,
  // Booking lists are paged.
  pageSize: 20,
  maxPageSize: 100,
};
