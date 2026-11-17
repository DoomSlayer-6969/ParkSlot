import { createServer as createHttpsServer } from 'node:https';
import { isAbsolute, relative } from 'node:path';
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { createMailerFromConfig } from './services/mailer.js';
import { createMockGateway } from './services/payments.js';
import { createTrafficProviderFromConfig } from './services/traffic.js';
import { DEMO_ADMIN, DEMO_USER, ensureDemoAdmin, hasSpots, seedDemoData } from './seed.js';
import { loadTlsCredentials, networkAddresses } from './tls.js';

// Created first so a bad email, traffic or HTTPS configuration stops start-up before anything else happens.
const mailer = createMailerFromConfig(config);
const traffic = createTrafficProviderFromConfig(config.traffic);
const lanAddresses = networkAddresses();
const tlsHosts = ['localhost', '127.0.0.1', ...lanAddresses];
const tls = config.httpsPort ? loadTlsCredentials(config, tlsHosts) : null;

/** A path relative to the working directory when it is inside it, otherwise absolute. */
function displayPath(path) {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

const db = openDb(config.dbFile);
if (!hasSpots(db)) {
  const seeded = seedDemoData(db);
  console.log(`Seeded ${seeded.lots} parking lots near ${seeded.stations} metro stations. Demo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
}
if (ensureDemoAdmin(db)) {
  console.log(`No admin account existed, so created a demo admin: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
}

if (mailer.kind === 'smtp') {
  mailer.verify().then(
    () => console.log(`Email: sending through SMTP server ${config.smtp.host}:${config.smtp.port}`),
    (err) => console.warn(`Email: cannot reach SMTP server ${config.smtp.host}:${config.smtp.port} (${err.message}). Emails will fail until this is fixed.`),
  );
} else {
  console.log('Email: SMTP_HOST is not set, so emails are printed here instead of being sent.');
}

if (traffic.name === 'tomtom') {
  console.log(`Traffic: live TomTom traffic prices lots (readings cached ${config.traffic.cacheSeconds} s).`);
} else {
  console.log('Traffic: no live traffic provider (set TOMTOM_API_KEY), so prices carry no traffic surcharge.');
}

const app = createApp({ db, gateway: createMockGateway(), mailer, traffic });

/** A port that is taken (e.g. another copy of the server is running) stops start-up with a clear message. */
const exitOnListenError = (what, port) => (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `${what} port ${port} is already in use (is another ParkSlot server running?). Stop it, or choose another port.`
    : `Cannot listen on ${what} port ${port}: ${err.message}`);
  process.exit(1);
};

// Express 5 calls this with the error when the port can't be used.
app.listen(config.port, (err) => {
  if (err) return exitOnListenError('HTTP', config.port)(err);
  console.log(`ParkSlot running at http://localhost:${config.port}`);
  console.log(`Admin portal: http://localhost:${config.port}/admin/ (the camera scanner works here)`);
});

if (tls) {
  createHttpsServer({ cert: tls.cert, key: tls.key }, app).listen(config.httpsPort, () => {
    if (tls.generated) {
      console.log(`HTTPS: created a self-signed certificate in ${displayPath(config.tlsDir)} for ${tlsHosts.join(', ')}.`);
    }
    console.log(`HTTPS: https://localhost:${config.httpsPort}`);
    for (const address of lanAddresses) {
      console.log(`  Admin portal for phones on this network: https://${address}:${config.httpsPort}/admin/`);
    }
    if (!config.tlsCertFile) console.log('  The certificate is self-signed: browsers warn once. Choose "Advanced", then continue to the site.');
  }).on('error', exitOnListenError('HTTPS', config.httpsPort));
} else if (lanAddresses.length) {
  console.log(`To use the camera scanner from a phone on this network, set HTTPS_PORT (e.g. HTTPS_PORT=3443) and restart.`);
}
