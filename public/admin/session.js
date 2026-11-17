// The admin's session and portal settings, shared by every admin module.
import { createApiClient, money as formatMoney } from '../common.js';

export const session = {
  config: null, // from /api/config
  user: null,   // the signed-in admin, or null
};

const listeners = [];

/** Calls `fn()` after every sign-in and sign-out. */
export function onSessionChange(fn) {
  listeners.push(fn);
}

export function setSession(token, user) {
  client.setToken(token);
  session.user = user;
  for (const fn of listeners) fn();
}

// Kept apart from the driver app's session (key 'token'). A 403 means the stored session is not an
// admin's, so it signs out too.
const client = createApiClient({ tokenKey: 'adminToken', signOutStatuses: [401, 403], onSignedOut: () => setSession(null, null) });

export const api = (path, options) => client.call(path, options);
export const hasStoredToken = () => Boolean(client.token);

export const money = (amount) => formatMoney(amount, session.config.currency);
