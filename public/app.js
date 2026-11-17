// Driver app entry point. The modules in driver/ import each other in one direction only:
//   session → modal → finder → pass → my-bookings → account → booking
// Choosing a slot (finder) starts a booking through the callback wired up here.
import { $, esc } from './common.js';
import { initAccount } from './driver/account.js';
import { startBooking } from './driver/booking.js';
import { initFinder } from './driver/finder.js';
import { api, hasStoredToken, session, setSession } from './driver/session.js';

async function init() {
  session.config = await api('/api/config');
  if (hasStoredToken()) {
    try {
      session.user = (await api('/api/auth/me')).user;
    } catch {
      setSession(null, null);
    }
  }
  initAccount();
  initFinder({ onSlotSelected: startBooking });
}

init().catch((err) => {
  $('#results').innerHTML = `<p class="error">Could not start the app: ${esc(err.message)}</p>`;
});
