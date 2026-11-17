// The driver app's API, mounted at /api: driver accounts, finding parking, and booking.
import express from 'express';
import { listOptions, number } from '../http.js';
import { login, logout, register } from '../services/auth.js';
import {
  cancelBooking, createHold, getUserBooking, listUserBookings, payForBooking,
} from '../services/bookings.js';
import { getPassPayload } from '../services/checkin.js';
import { qrSvg } from '../services/passes.js';
import { confirmPasswordReset, requestPasswordReset, RESET_REQUESTED_MESSAGE } from '../services/password-reset.js';
import { findNearby, getSpot } from '../services/spots.js';

export function driverRoutes({ db, gateway, mailer, clock, requireRole }) {
  const router = express.Router();
  const requireUser = requireRole('user');

  // --- Accounts ---
  router.post('/auth/register', (req, res) => res.status(201).json(register(db, req.body ?? {}, clock(), mailer)));
  router.post('/auth/login', (req, res) => res.json(login(db, req.body ?? {}, clock(), 'user')));
  router.post('/auth/logout', requireUser, (req, res) => {
    logout(db, req.token);
    res.status(204).end();
  });
  router.get('/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

  // Same response whether or not the account exists.
  router.post('/auth/password-reset/request', (req, res) => {
    requestPasswordReset(db, mailer, { email: req.body?.email }, clock());
    res.status(202).json({ message: RESET_REQUESTED_MESSAGE });
  });
  router.post('/auth/password-reset/confirm', (req, res) => {
    res.json(confirmPasswordReset(db, { token: req.body?.token, password: req.body?.password }, clock()));
  });

  // --- Parking spots (public) ---
  router.get('/spots', (req, res) => {
    const lat = number(req.query.lat, 'lat');
    const lng = number(req.query.lng, 'lng');
    const radiusKm = Math.min(Math.max(number(req.query.radius, 'radius', 3), 0.1), 20);
    res.json({ spots: findNearby(db, { lat, lng, radiusKm }, clock()) });
  });

  router.get('/spots/:id', (req, res) => {
    const now = clock();
    res.json(getSpot(db, number(req.params.id, 'id'), {
      startAt: number(req.query.start, 'start', now),
      hours: number(req.query.hours, 'hours', 1),
    }, now));
  });

  // --- Bookings ---
  const bookingRef = (req) => ({ bookingId: number(req.params.id, 'id'), userId: req.user.id });

  router.get('/bookings', requireUser, (req, res) => {
    res.json(listUserBookings(db, req.user.id, clock(), listOptions(req.query)));
  });

  router.get('/bookings/:id', requireUser, (req, res) => res.json(getUserBooking(db, bookingRef(req), clock())));

  router.post('/bookings', requireUser, (req, res) => {
    const body = req.body ?? {};
    res.status(201).json(createHold(db, {
      userId: req.user.id,
      slotId: number(body.slotId, 'slotId'),
      startAt: number(body.startAt, 'startAt'),
      hours: number(body.hours, 'hours'),
    }, clock()));
  });

  // The QR pass the driver shows at the gate. It is a credential, so it is never cached.
  router.get('/bookings/:id/qr', requireUser, (req, res) => {
    const payload = getPassPayload(db, bookingRef(req), clock());
    res.set('Cache-Control', 'no-store').type('image/svg+xml').send(qrSvg(payload));
  });

  router.post('/bookings/:id/pay', requireUser, async (req, res) => {
    res.json(await payForBooking(db, gateway, { ...bookingRef(req), card: req.body?.card }, clock));
  });

  router.post('/bookings/:id/cancel', requireUser, async (req, res) => {
    res.json(await cancelBooking(db, gateway, bookingRef(req), clock));
  });

  return router;
}
