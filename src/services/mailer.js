import nodemailer from 'nodemailer';

// A mailer is any object with an async `send({ to, subject, text })`.

/** Development mailer: prints each message to the server console instead of sending it. */
export function createConsoleMailer(log = console.log) {
  return {
    kind: 'console',
    async send({ to, subject, text }) {
      log(`\n----- email to ${to} -----\nSubject: ${subject}\n\n${text}\n--------------------------\n`);
    },
    async verify() {},
  };
}

/** Sends real email through an SMTP server (any provider: SES, Postmark, Gmail, Mailgun, ...). */
export function createSmtpMailer({ host, port, secure, user, pass, from }) {
  if (!host) throw new Error('SMTP host is required');
  if (!from) throw new Error('MAIL_FROM must be set when SMTP is configured, e.g. "ParkSlot <no-reply@example.com>"');
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass: pass ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    kind: 'smtp',
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
    /** Checks the connection and login, so a misconfiguration shows up at start-up. */
    async verify() {
      await transport.verify();
    },
    close: () => transport.close(),
  };
}

/** SMTP when SMTP_HOST is configured, otherwise the console. */
export function createMailerFromConfig(config) {
  return config.smtp.host ? createSmtpMailer({ ...config.smtp, from: config.mailFrom }) : createConsoleMailer();
}

/**
 * Sends without making the caller wait or fail: a slow or broken mail server must not
 * block or break the request that triggered the email (sign-up, password reset).
 */
export function sendInBackground(mailer, message) {
  const logFailure = (err) => console.error(`Could not send "${message.subject}" email to ${message.to}:`, err?.message ?? err);
  try {
    Promise.resolve(mailer.send(message)).catch(logFailure);
  } catch (err) {
    logFailure(err);
  }
}
