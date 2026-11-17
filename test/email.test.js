import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { createAccount } from '../src/services/auth.js';
import { welcomeEmail } from '../src/services/emails.js';
import { createMailerFromConfig, createSmtpMailer } from '../src/services/mailer.js';
import { startServer } from './support/server.js';

const DRIVER = { name: 'Dana Driver', email: 'dana@test.dev', password: 'password1' };

/** A tiny SMTP server that accepts everything and records what it received. */
async function startFakeSmtp(t) {
  const received = [];
  const server = createServer((socket) => {
    let mail = { from: null, to: [], auth: null, data: '' };
    let buffer = '';
    let inData = false;
    let awaitingAuth = false;
    const reply = (line) => socket.write(`${line}\r\n`);
    const readAuth = (b64) => { mail.auth = Buffer.from(b64, 'base64').toString('utf8').split('\0').slice(1); };
    reply('220 fake.smtp ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          mail.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(mail);
          mail = { from: null, to: [], auth: mail.auth, data: '' };
          reply('250 OK queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const cmd = line.toUpperCase();

        if (awaitingAuth) { awaitingAuth = false; readAuth(line); reply('235 Authenticated'); }
        else if (cmd.startsWith('EHLO')) socket.write('250-fake.smtp\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (cmd.startsWith('HELO')) reply('250 fake.smtp');
        else if (cmd.startsWith('AUTH PLAIN')) {
          const initial = line.split(' ')[2];
          if (initial) { readAuth(initial); reply('235 Authenticated'); } else { awaitingAuth = true; reply('334 '); }
        } else if (cmd.startsWith('MAIL FROM:')) { mail.from = line.slice(10).trim(); reply('250 OK'); }
        else if (cmd.startsWith('RCPT TO:')) { mail.to.push(line.slice(8).trim()); reply('250 OK'); }
        else if (cmd === 'DATA') { inData = true; reply('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'QUIT') { reply('221 Bye'); socket.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') reply('250 OK');
        else reply('502 Command not implemented');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { port: server.address().port, received };
}

/** Undoes quoted-printable encoding, which nodemailer uses for long text lines. */
const decodeQP = (s) => s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

async function waitFor(check, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startApp(t, mailer) {
  const { db, call } = await startServer(t, { mailer });
  const register = (body) => call('/api/auth/register', { method: 'POST', body });
  return { db, register };
}

test('signing up sends a welcome email; failed sign-ups send none', async (t) => {
  const outbox = [];
  const { db, register } = await startApp(t, { send: async (m) => { outbox.push(m); } });

  assert.equal((await register(DRIVER)).status, 201);
  assert.equal(outbox.length, 1);
  const [mail] = outbox;
  assert.equal(mail.to, DRIVER.email);
  assert.equal(mail.subject, 'Welcome to ParkSlot');
  assert.match(mail.text, /^Hi Dana Driver,/);
  assert.match(mail.text, /log in at http:\/\/localhost:\d+\/ with this email address \(dana@test\.dev\)/);
  assert.match(mail.text, /Forgot password\?/);
  assert.match(mail.text, /QR code/);
  assert.doesNotMatch(mail.text, /booking ID/i); // check-in is by QR code, not a code read out at the gate

  assert.equal((await register(DRIVER)).status, 409); // duplicate
  assert.equal((await register({ ...DRIVER, email: 'x@test.dev', password: 'short' })).status, 400);
  assert.equal((await register({ ...DRIVER, email: 'not-an-email' })).status, 400);
  createAccount(db, { name: 'Admin', email: 'admin@test.dev', password: 'password1', role: 'admin' }, Date.now());
  assert.equal(outbox.length, 1, 'only the successful driver sign-up sends an email');
});

test('a broken or slow mailer never blocks or breaks sign-up', async (t) => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = originalError; });

  const failing = await startApp(t, { send: async () => { throw new Error('SMTP down'); } });
  assert.equal((await failing.register(DRIVER)).status, 201);
  const throwing = await startApp(t, { send: () => { throw new Error('bad config'); } });
  assert.equal((await throwing.register(DRIVER)).status, 201);
  const hanging = await startApp(t, { send: () => new Promise(() => {}) });
  assert.equal((await hanging.register(DRIVER)).status, 201);

  await waitFor(() => errors.length === 2);
  assert.match(errors[0], /Could not send "Welcome to ParkSlot" email to dana@test\.dev: SMTP down/);
  assert.match(errors[1], /bad config/);
});

test('the SMTP mailer delivers through a real SMTP conversation, logging in when credentials are set', async (t) => {
  const smtp = await startFakeSmtp(t);
  const mailer = createSmtpMailer({
    host: '127.0.0.1', port: smtp.port, secure: false, user: 'mailuser', pass: 'mailpass', from: 'ParkSlot <no-reply@parkslot.test>',
  });
  t.after(() => mailer.close());
  await mailer.verify();

  await mailer.send(welcomeEmail({ name: 'Dana Driver', email: 'dana@test.dev' }));
  assert.equal(smtp.received.length, 1);
  const [mail] = smtp.received;
  assert.deepEqual(mail.auth, ['mailuser', 'mailpass']);
  assert.match(mail.from, /^<no-reply@parkslot\.test>/);
  assert.deepEqual(mail.to, ['<dana@test.dev>']);
  assert.match(mail.data, /^From: ParkSlot <no-reply@parkslot\.test>$/m);
  assert.match(mail.data, /^To: dana@test\.dev$/m);
  assert.match(mail.data, /^Subject: Welcome to ParkSlot$/m);
  assert.match(decodeQP(mail.data), /Hi Dana Driver,/);
  assert.match(decodeQP(mail.data), /Your ParkSlot account is ready\. You can log in at http:\/\/localhost:\d+\/ with this email address/);
});

test('signing up over HTTP with the SMTP mailer delivers the welcome email', async (t) => {
  const smtp = await startFakeSmtp(t);
  const mailer = createSmtpMailer({ host: '127.0.0.1', port: smtp.port, secure: false, from: 'no-reply@parkslot.test' });
  t.after(() => mailer.close());
  const { register } = await startApp(t, mailer);

  const res = await register(DRIVER);
  assert.equal(res.status, 201);
  await waitFor(() => smtp.received.length === 1);
  assert.deepEqual(smtp.received[0].to, ['<dana@test.dev>']);
  assert.equal(smtp.received[0].auth, null, 'no AUTH without credentials');
});

test('mailer selection: console without SMTP_HOST, SMTP with it, and MAIL_FROM is required for SMTP', () => {
  const smtp = { host: null, port: 587, secure: false, user: null, pass: null };
  assert.equal(createMailerFromConfig({ smtp, mailFrom: null }).kind, 'console');
  assert.equal(createMailerFromConfig({ smtp: { ...smtp, host: 'smtp.example.com' }, mailFrom: 'a@example.com' }).kind, 'smtp');
  assert.throws(() => createMailerFromConfig({ smtp: { ...smtp, host: 'smtp.example.com' }, mailFrom: null }), /MAIL_FROM/);
});

test('verify reports an SMTP server that cannot be reached', async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close(); // nothing listens on this port now
  const mailer = createSmtpMailer({ host: '127.0.0.1', port, secure: false, from: 'a@example.com' });
  await assert.rejects(mailer.verify(), /ECONNREFUSED/);
  mailer.close();
});
