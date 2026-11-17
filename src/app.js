import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { roleGuard } from './http.js';
import { adminRoutes } from './routes/admin.js';
import { driverRoutes } from './routes/driver.js';
import { createConsoleMailer } from './services/mailer.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
// QR decoder for the admin portal's camera scanner, used where the browser has no BarcodeDetector.
const jsQrFile = createRequire(import.meta.url).resolve('jsqr');

/** The whole app. Dependencies are injected so tests can use an in-memory DB, fake mailer and fake clock. */
export function createApp({ db, gateway, mailer = createConsoleMailer(), clock = Date.now }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  // The old shared-key attendant screen is now part of the admin portal.
  app.get('/attendant.html', (req, res) => res.redirect(301, '/admin/'));
  app.use(express.static(publicDir));
  app.get('/vendor/jsQR.js', (req, res) => res.sendFile(jsQrFile));

  app.get('/api/config', (req, res) => {
    res.json({
      currency: config.currency,
      defaultCenter: config.defaultCenter,
      holdMinutes: config.holdMinutes,
      maxHours: config.maxHours,
      maxAdvanceDays: config.maxAdvanceDays,
      resetTokenMinutes: config.resetTokenMinutes,
      // Lets the admin portal, opened over plain HTTP on a network address, link to the HTTPS
      // address where the browser allows the camera.
      httpsPort: config.httpsPort,
    });
  });

  const deps = { db, gateway, mailer, clock, requireRole: roleGuard(db, clock) };
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api', driverRoutes(deps));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
