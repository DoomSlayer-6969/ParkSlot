// The admin portal's API, mounted at /api/admin: staff sign-in, check-in at the gate, and all bookings.
// New admin-only features go here (and in public/admin/).
import express from 'express';
import { listOptions, number } from '../http.js';
import { login, logout } from '../services/auth.js';
import { getBookingForAdmin, listAllBookings } from '../services/bookings.js';
import { checkInManually, checkInWithPass } from '../services/checkin.js';

export function adminRoutes({ db, clock, requireRole }) {
  const router = express.Router();
  const requireAdmin = requireRole('admin');

  router.post('/auth/login', (req, res) => res.json(login(db, req.body ?? {}, clock(), 'admin')));
  router.post('/auth/logout', requireAdmin, (req, res) => {
    logout(db, req.token);
    res.status(204).end();
  });
  router.get('/auth/me', requireAdmin, (req, res) => res.json({ user: req.user }));

  // `qr` is the text read from the driver's QR code by the camera scanner or a handheld scanner.
  router.post('/checkin', requireAdmin, (req, res) => {
    res.json(checkInWithPass(db, { scanned: req.body?.qr, staffId: req.user.id }, clock()));
  });

  router.get('/bookings', requireAdmin, (req, res) => {
    res.json(listAllBookings(db, clock(), { ...listOptions(req.query), q: req.query.q }));
  });
  router.get('/bookings/:id', requireAdmin, (req, res) => {
    res.json(getBookingForAdmin(db, number(req.params.id, 'id'), clock()));
  });
  // For a driver who cannot show their QR code, once staff have checked who they are.
  router.post('/bookings/:id/checkin', requireAdmin, (req, res) => {
    res.json(checkInManually(db, { bookingId: number(req.params.id, 'id'), staffId: req.user.id }, clock()));
  });

  return router;
}
