import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError } from './errors.js';
import {
  confirmPasswordReset, login, logout, register, requestPasswordReset, RESET_REQUESTED_MESSAGE, userForToken,
} from './services/auth.js';
import { createConsoleMailer } from './services/mailer.js';
import {
  cancelBooking, checkIn, createHold, getBookingForAdmin, getUserBooking, listAllBookings, listUserBookings,
  payForBooking,
} from './services/bookings.js';
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

/** Paging and scope query parameters shared by the booking lists. */
function listOptions(query) {
  return {
    scope: String(query.scope ?? 'all'),
    limit: number(query.limit, 'limit', config.pageSize),
    offset: number(query.offset, 'offset', 0),
  };
}

export function createApp({ db, gateway, mailer = createConsoleMailer(), clock = Date.now }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  // The old shared-key attendant screen is now part of the admin portal.
  app.get('/attendant.html', (req, res) => res.redirect(301, '/admin/'));
  app.use(express.static(publicDir));

  // The driver app and the admin portal are separate: a session only works in the portal of its account's role.
  const requireRole = (role) => (req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const user = token && userForToken(db, token, clock());
    if (!user) throw new HttpError(401, role === 'admin' ? 'Please sign in to the admin portal' : 'Please log in to continue');
    if (user.role !== role) {
      throw new HttpError(403, role === 'admin' ? 'Admin access required' : 'Admin accounts cannot use the driver app');
    }
    req.user = user;
    req.token = token;
    next();
  };
  const requireUser = requireRole('user');
  const requireAdmin = requireRole('admin');

  app.get('/api/config', (req, res) => {
    res.json({
      currency: config.currency,
      defaultCenter: config.defaultCenter,
      holdMinutes: config.holdMinutes,
      maxHours: config.maxHours,
      maxAdvanceDays: config.maxAdvanceDays,
      resetTokenMinutes: config.resetTokenMinutes,
    });
  });

  // --- Driver auth ---
  app.post('/api/auth/register', (req, res) => res.status(201).json(register(db, req.body ?? {}, clock(), mailer)));
  app.post('/api/auth/login', (req, res) => res.json(login(db, req.body ?? {}, clock(), 'user')));
  app.post('/api/auth/logout', requireUser, (req, res) => {
    logout(db, req.token);
    res.status(204).end();
  });
  app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

  // Same response whether or not the account exists.
  app.post('/api/auth/password-reset/request', (req, res) => {
    requestPasswordReset(db, mailer, { email: req.body?.email }, clock());
    res.status(202).json({ message: RESET_REQUESTED_MESSAGE });
  });
  app.post('/api/auth/password-reset/confirm', (req, res) => {
    res.json(confirmPasswordReset(db, { token: req.body?.token, password: req.body?.password }, clock()));
  });

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
    res.json(listUserBookings(db, req.user.id, clock(), listOptions(req.query)));
  });

  app.get('/api/bookings/:id', requireUser, (req, res) => {
    res.json(getUserBooking(db, { bookingId: number(req.params.id, 'id'), userId: req.user.id }, clock()));
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

  // --- Admin portal ---
  const admin = express.Router();
  admin.post('/auth/login', (req, res) => res.json(login(db, req.body ?? {}, clock(), 'admin')));
  admin.post('/auth/logout', requireAdmin, (req, res) => {
    logout(db, req.token);
    res.status(204).end();
  });
  admin.get('/auth/me', requireAdmin, (req, res) => res.json({ user: req.user }));

  admin.post('/checkin', requireAdmin, (req, res) => res.json(checkIn(db, req.body?.code, clock())));

  admin.get('/bookings', requireAdmin, (req, res) => {
    res.json(listAllBookings(db, clock(), { ...listOptions(req.query), q: req.query.q }));
  });
  admin.get('/bookings/:id', requireAdmin, (req, res) => {
    res.json(getBookingForAdmin(db, number(req.params.id, 'id'), clock()));
  });
  app.use('/api/admin', admin);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
