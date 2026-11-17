// Creates an admin account. Admins cannot sign up through the app.
// Usage: npm run create-admin -- --name "Asha Rao" --email asha@example.com --password 'a-long-password'
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { openDb } from './db.js';
import { createAccount } from './services/auth.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
  },
});

try {
  const admin = createAccount(openDb(config.dbFile), { ...values, role: 'admin' }, Date.now());
  console.log(`Created admin ${admin.email}. Sign in at /admin/.`);
} catch (err) {
  console.error(`Could not create admin: ${err.message}`);
  process.exitCode = 1;
}
