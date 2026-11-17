// Admin portal entry point: sign-in, the header, and switching between the Check-in and Bookings panels.
// Modules import in one direction only: session → bookings → checkin → admin.js.
import { $, esc, request } from '../common.js';
import { resetBookings, showBookingsPanel } from './bookings.js';
import { focusScanInput, initCheckin, resetCheckin, stopCamera } from './checkin.js';
import { api, hasStoredToken, onSessionChange, session, setSession } from './session.js';

function render() {
  const signedIn = Boolean(session.user);
  $('#login-view').hidden = signedIn;
  $('#app-view').hidden = !signedIn;
  $('#admin-auth').innerHTML = signedIn
    ? `<span class="who">${esc(session.user.name)}</span><button class="btn ghost" id="logout-btn">Sign out</button>`
    : '';
  if (signedIn) {
    if (!$('#checkin-panel').hidden) focusScanInput();
    $('#logout-btn').onclick = async () => {
      await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
    };
  } else {
    resetCheckin();
    resetBookings();
  }
}

// ---------------------------------------------------------------- sign in

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const { token, user } = await api('/api/admin/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    setSession(token, user);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- tabs

function showPanel(name) {
  for (const tab of document.querySelectorAll('[data-panel]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.panel === name));
  }
  $('#checkin-panel').hidden = name !== 'checkin';
  $('#bookings-panel').hidden = name !== 'bookings';
  if (name === 'bookings') {
    stopCamera();
    showBookingsPanel();
  } else {
    focusScanInput();
  }
}

for (const tab of document.querySelectorAll('[data-panel]')) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
}
for (const link of document.querySelectorAll('[data-panel-link]')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showPanel(link.dataset.panelLink);
  });
}

// ---------------------------------------------------------------- init

async function init() {
  session.config = await request('/api/config');
  if (hasStoredToken()) {
    try {
      session.user = (await api('/api/admin/auth/me')).user;
    } catch {
      setSession(null, null);
    }
  }
  onSessionChange(render);
  initCheckin();
  render();
}

init().catch((err) => {
  document.querySelector('main').innerHTML = `<p class="error narrow">Could not start the admin portal: ${esc(err.message)}</p>`;
});
