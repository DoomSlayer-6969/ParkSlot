// The driver's session and app-wide settings, shared by every driver module.
import { createApiClient, money as formatMoney } from '../common.js';

export const session = {
  config: null, // from /api/config
  user: null,   // the signed-in driver, or null
};

const listeners = [];

/** Calls `fn()` after every sign-in and sign-out (e.g. to redraw the header). */
export function onSessionChange(fn) {
  listeners.push(fn);
}

export function setSession(token, user) {
  client.setToken(token);
  session.user = user;
  for (const fn of listeners) fn();
}

// The admin portal keeps its session under a different key, so the two never mix.
const client = createApiClient({ tokenKey: 'token', onSignedOut: () => setSession(null, null) });

/** Calls the API with the driver's session. A 401 (session expired) signs the driver out. */
export const api = (path, options) => client.call(path, options);
export const hasStoredToken = () => Boolean(client.token);

export const money = (amount) => formatMoney(amount, session.config.currency);
