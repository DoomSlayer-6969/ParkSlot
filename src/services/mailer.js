/**
 * Development stand-in for an email provider: prints each message to the server
 * console. A real adapter (SMTP, SES, Postmark, ...) implements the same async
 * `send({ to, subject, text })`.
 */
export function createConsoleMailer(log = console.log) {
  return {
    async send({ to, subject, text }) {
      log(`\n----- email to ${to} -----\nSubject: ${subject}\n\n${text}\n--------------------------\n`);
    },
  };
}
