import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { createMailerFromConfig } from './services/mailer.js';
import { createMockGateway } from './services/payments.js';
import { DEMO_ADMIN, DEMO_USER, ensureDemoAdmin, hasSpots, seedDemoData } from './seed.js';

// Created first so a bad email configuration stops start-up before anything else happens.
const mailer = createMailerFromConfig(config);

const db = openDb(config.dbFile);
if (!hasSpots(db)) {
  seedDemoData(db, config.defaultCenter);
  console.log(`Seeded demo data. Demo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
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

createApp({ db, gateway: createMockGateway(), mailer }).listen(config.port, () => {
  console.log(`ParkSlot running at http://localhost:${config.port}`);
  console.log(`Admin portal: http://localhost:${config.port}/admin/`);
});
