import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { createConsoleMailer } from './services/mailer.js';
import { createMockGateway } from './services/payments.js';
import { DEMO_ADMIN, DEMO_USER, ensureDemoAdmin, hasSpots, seedDemoData } from './seed.js';

const db = openDb(config.dbFile);
if (!hasSpots(db)) {
  seedDemoData(db, config.defaultCenter);
  console.log(`Seeded demo data. Demo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
}
if (ensureDemoAdmin(db)) {
  console.log(`No admin account existed, so created a demo admin: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
}

// Emails (password reset links) are printed to this console until a real mail provider is plugged in.
createApp({ db, gateway: createMockGateway(), mailer: createConsoleMailer() }).listen(config.port, () => {
  console.log(`ParkSlot running at http://localhost:${config.port}`);
  console.log(`Admin portal: http://localhost:${config.port}/admin/`);
});
