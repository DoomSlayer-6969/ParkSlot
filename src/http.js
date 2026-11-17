// Request helpers shared by the route modules.
import { config } from './config.js';
import { HttpError } from './errors.js';
import { userForToken } from './services/auth.js';

/** Parses a numeric query/body/path value. `fallback` is used when it is missing; otherwise it is required. */
export function number(value, name, fallback) {
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${name} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return n;
}

/** Paging and scope query parameters shared by the booking lists. */
export function listOptions(query) {
  return {
    scope: String(query.scope ?? 'all'),
    limit: number(query.limit, 'limit', config.pageSize),
    offset: number(query.offset, 'offset', 0),
  };
}

/**
 * Middleware factory: `requireRole('user')` / `requireRole('admin')`. The driver app and the admin portal
 * are separate, so a session only works in the portal of its account's role: no session gives 401, a
 * session of the other role gives 403. Sets `req.user` and `req.token`.
 */
export function roleGuard(db, clock) {
  return (role) => (req, res, next) => {
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
}
