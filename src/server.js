import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { createMockGateway } from './services/payments.js';
import { DEMO_USER, hasSpots, seedDemoData } from './seed.js';

const db = openDb(config.dbFile);
if (!hasSpots(db)) {
  seedDemoData(db, config.defaultCenter);
  console.log(`Seeded demo data. Demo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
}

createApp({ db, gateway: createMockGateway() }).listen(config.port, () => {
  console.log(`ParkSlot running at http://localhost:${config.port}`);
  console.log(`Attendant check-in: http://localhost:${config.port}/attendant.html (key: ${config.attendantKey})`);
});
