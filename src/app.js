import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { login, logout, register, userForToken } from './services/auth.js';
import { cancelBooking, checkIn, createHold, listUserBookings, payForBooking } from './services/bookings.js';
import { findNearby, getSpot } from './services/spots.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

function number(value, name, fallback) {
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${name} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return n;
}

export function createApp({ db, gateway, clock = Date.now }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(publicDir));

  const requireUser = (req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const user = token && userForToken(db, token, clock());
    if (!user) throw new HttpError(401, 'Please log in to continue');
    req.user = user;
    req.token = token;
    next();
  };

  const requireAttendant = (req, res, next) => {
    if (req.get('x-attendant-key') !== config.attendantKey) throw new HttpError(401, 'Invalid attendant key');
    next();
  };

  app.get('/api/config', (req, res) => {
    res.json({
      currency: config.currency,
      defaultCenter: config.defaultCenter,
      holdMinutes: config.holdMinutes,
      maxHours: config.maxHours,
      maxAdvanceDays: config.maxAdvanceDays,
    });
  });

  // --- Auth ---
  app.post('/api/auth/register', (req, res) => res.status(201).json(register(db, req.body ?? {}, clock())));
  app.post('/api/auth/login', (req, res) => res.json(login(db, req.body ?? {}, clock())));
  app.post('/api/auth/logout', requireUser, (req, res) => {
    logout(db, req.token);
    res.status(204).end();
  });
  app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

  // --- Parking spots ---
  app.get('/api/spots', (req, res) => {
    const lat = number(req.query.lat, 'lat');
    const lng = number(req.query.lng, 'lng');
    const radiusKm = Math.min(Math.max(number(req.query.radius, 'radius', 3), 0.1), 20);
    res.json({ spots: findNearby(db, { lat, lng, radiusKm }, clock()) });
  });

  app.get('/api/spots/:id', (req, res) => {
    const now = clock();
    res.json(getSpot(db, number(req.params.id, 'id'), {
      startAt: number(req.query.start, 'start', now),
      hours: number(req.query.hours, 'hours', 1),
    }, now));
  });

  // --- Bookings ---
  app.get('/api/bookings', requireUser, (req, res) => {
    res.json({ bookings: listUserBookings(db, req.user.id, clock()) });
  });

  app.post('/api/bookings', requireUser, (req, res) => {
    const body = req.body ?? {};
    res.status(201).json(createHold(db, {
      userId: req.user.id,
      slotId: number(body.slotId, 'slotId'),
      startAt: number(body.startAt, 'startAt'),
      hours: number(body.hours, 'hours'),
    }, clock()));
  });

  app.post('/api/bookings/:id/pay', requireUser, async (req, res) => {
    res.json(await payForBooking(db, gateway, {
      bookingId: number(req.params.id, 'id'),
      userId: req.user.id,
      card: req.body?.card,
    }, clock));
  });

  app.post('/api/bookings/:id/cancel', requireUser, async (req, res) => {
    res.json(await cancelBooking(db, gateway, { bookingId: number(req.params.id, 'id'), userId: req.user.id }, clock));
  });

  // --- Attendant ---
  app.post('/api/checkin', requireAttendant, (req, res) => res.json(checkIn(db, req.body?.code, clock())));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
