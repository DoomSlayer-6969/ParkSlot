import { $, esc, fmtDateTime, money as formatMoney, paymentList, request, STATUS_TEXT, storage } from '../common.js';
import { startScanner } from './scanner.js';

// Admin sessions are kept apart from the driver app's (which uses the 'token' key).
const TOKEN_KEY = 'adminToken';

const state = {
  config: null,
  token: storage.get(TOKEN_KEY),
  user: null,
  bookingsLoaded: false,
};

const money = (amount) => formatMoney(amount, state.config.currency);
const statusBadge = (status) => `<span class="badge status-${esc(status)}">${STATUS_TEXT[status] ?? esc(status)}</span>`;

function api(path, options = {}) {
  const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
  return request(path, { ...options, headers }).catch((err) => {
    if ((err.status === 401 || err.status === 403) && state.user) setSession(null, null);
    throw err;
  });
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  storage.set(TOKEN_KEY, token);
  render();
}

function render() {
  const signedIn = Boolean(state.user);
  $('#login-view').hidden = signedIn;
  $('#app-view').hidden = !signedIn;
  $('#admin-auth').innerHTML = signedIn
    ? `<span class="who">${esc(state.user.name)}</span><button class="btn ghost" id="logout-btn">Sign out</button>`
    : '';
  if (signedIn) {
    if (!$('#checkin-panel').hidden) focusScanInput();
    $('#logout-btn').onclick = async () => {
      await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
    };
  } else {
    stopCamera();
    state.bookingsLoaded = false;
    $('#bookings-body').innerHTML = '';
    $('#checkin-result').innerHTML = '';
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
    if (!state.bookingsLoaded) searchBookings();
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

// ---------------------------------------------------------------- check-in

// Staff scan the QR pass on the driver's phone, with this device's camera or a handheld (USB/Bluetooth)
// scanner, which types the QR code's text into the input followed by Enter.

const CHECKED_IN_BY = { qr: 'QR scan', manual: 'manually' };

function checkedInText(b) {
  const how = CHECKED_IN_BY[b.checkin_method];
  return `${fmtDateTime(b.checked_in_at)}${how ? ` · ${how}` : ''}${b.checked_in_by_name ? ` by ${esc(b.checked_in_by_name)}` : ''}`;
}

function bookingDetails(b) {
  return `
    <dl class="summary">
      <dt>Driver</dt><dd>${esc(b.user_name)}</dd>
      <dt>Spot</dt><dd>${esc(b.spot_name)}</dd>
      <dt>Slot</dt><dd><b>${esc(b.slot_label)}</b></dd>
      <dt>Window</dt><dd>${fmtDateTime(b.start_at)} – ${fmtDateTime(b.end_at)}</dd>
      <dt>Status</dt><dd>${STATUS_TEXT[b.status] ?? esc(b.status)}</dd>
      ${b.checked_in_at ? `<dt>Checked in</dt><dd>${checkedInText(b)}</dd>` : ''}
      <dt>Reference</dt><dd class="code">${esc(b.code)}</dd>
    </dl>`;
}

const scan = { busy: false, last: null, lastAt: 0, stop: null };
// While a pass is held in front of the camera it is read many times a second; it is sent once.
const SAME_PASS_IGNORE_MS = 8000;

async function submitScan(text, { fromCamera = false } = {}) {
  if (scan.busy) return;
  const now = Date.now();
  if (fromCamera && text === scan.last && now - scan.lastAt < SAME_PASS_IGNORE_MS) return;
  scan.busy = true;
  scan.last = text;
  scan.lastAt = now;

  const result = $('#checkin-result');
  try {
    const booking = await api('/api/admin/checkin', { method: 'POST', body: { qr: text } });
    result.innerHTML = `<div class="card result ok"><h2>Checked in — direct the driver to slot ${esc(booking.slot_label)}</h2>${bookingDetails(booking)}</div>`;
    navigator.vibrate?.(120);
    state.bookingsLoaded = false; // statuses changed
  } catch (err) {
    const booking = err.data?.booking;
    result.innerHTML = `<div class="card result bad"><h2>${esc(err.message)}</h2>${booking ? bookingDetails(booking) : ''}</div>`;
    navigator.vibrate?.([80, 60, 80]);
  } finally {
    scan.busy = false;
  }
}

function focusScanInput() {
  // On touch devices focusing would pop up the keyboard; handheld scanners are used with desktops.
  if (matchMedia('(pointer: fine)').matches) $('#checkin-form').qr.focus();
}

$('#checkin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.qr;
  const text = input.value.trim();
  input.value = '';
  if (text) submitScan(text);
  input.focus();
});

function setCameraUi(on, status = '') {
  $('#scanner-view').hidden = !on;
  $('#camera-btn').textContent = on ? 'Stop camera' : 'Scan with camera';
  $('#scanner-status').textContent = status;
}

function stopCamera() {
  scan.stop?.();
  scan.stop = null;
  setCameraUi(false);
}

$('#camera-btn').addEventListener('click', async (e) => {
  if (scan.stop) {
    stopCamera();
    return;
  }
  const btn = e.currentTarget;
  btn.disabled = true;
  setCameraUi(true, 'Starting the camera…');
  try {
    const stop = await startScanner($('#scanner-video'), (text) => submitScan(text, { fromCamera: true }));
    if (!state.user || $('#checkin-panel').hidden) {
      stop(); // signed out or switched tabs while the camera was starting
      return;
    }
    scan.stop = stop;
    setCameraUi(true, 'Hold the QR code inside the frame.');
  } catch (err) {
    setCameraUi(false);
    $('#scanner-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// Release the camera when the portal is in the background.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

// ---------------------------------------------------------------- bookings

function bookingRow(b) {
  return `
    <tr data-booking="${b.id}" tabindex="0">
      <td class="code">${esc(b.code ?? '—')}</td>
      <td>${esc(b.user_name)}<br><span class="muted small">${esc(b.user_email)}</span></td>
      <td>${esc(b.spot_name)} · ${esc(b.slot_label)}</td>
      <td>${fmtDateTime(b.start_at)}<br><span class="muted small">${b.hours} h</span></td>
      <td>${money(b.amount)}</td>
      <td>${statusBadge(b.status)}</td>
    </tr>`;
}

let searchSeq = 0;

async function loadBookings(offset) {
  const seq = searchSeq;
  const { q, scope } = Object.fromEntries(new FormData($('#booking-search')));
  const params = new URLSearchParams({ scope, offset: String(offset) });
  if (q.trim()) params.set('q', q.trim());
  const more = $('#load-more');
  more.disabled = true;
  try {
    const page = await api(`/api/admin/bookings?${params}`);
    if (seq !== searchSeq) return; // a newer search replaced this one
    $('#bookings-body').insertAdjacentHTML('beforeend', page.bookings.map(bookingRow).join(''));
    $('#bookings-status').textContent = $('#bookings-body').children.length ? '' : 'No bookings match.';
    more.hidden = !page.has_more;
    more.onclick = () => loadBookings(page.next_offset);
    state.bookingsLoaded = true;
  } catch (err) {
    if (seq === searchSeq) $('#bookings-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    more.disabled = false;
  }
}

function searchBookings() {
  searchSeq += 1;
  $('#bookings-body').innerHTML = '';
  $('#bookings-status').textContent = 'Loading…';
  $('#load-more').hidden = true;
  loadBookings(0);
}

$('#booking-search').addEventListener('submit', (e) => {
  e.preventDefault();
  searchBookings();
});
$('#booking-search').scope.addEventListener('change', searchBookings);

const openRow = (e) => {
  const row = e.target.closest('[data-booking]');
  if (row) showBooking(Number(row.dataset.booking));
};
$('#bookings-body').addEventListener('click', openRow);
$('#bookings-body').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });

// ---------------------------------------------------------------- booking detail

const dialog = $('#modal');
$('#modal-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => {
  if (!state.bookingsLoaded && !$('#bookings-panel').hidden) searchBookings(); // a booking was checked in
});

async function showBooking(id) {
  let b;
  try {
    b = await api(`/api/admin/bookings/${id}`);
  } catch (err) {
    $('#modal-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    if (!dialog.open) dialog.showModal();
    return;
  }
  $('#modal-body').innerHTML = `
    <h2>Booking <span class="code">${esc(b.code ?? `#${b.id}`)}</span></h2>
    <dl class="summary">
      <dt>Status</dt><dd>${statusBadge(b.status)}</dd>
      <dt>Driver</dt><dd>${esc(b.user_name)}<br><span class="muted small">${esc(b.user_email)}</span></dd>
      <dt>Spot</dt><dd>${esc(b.spot_name)}<br><span class="muted small">${esc(b.spot_address)}</span></dd>
      <dt>Slot</dt><dd>${esc(b.slot_label)}</dd>
      <dt>Window</dt><dd>${fmtDateTime(b.start_at)} – ${fmtDateTime(b.end_at)} (${b.hours} h)</dd>
      ${b.checked_in_at ? `<dt>Checked in</dt><dd>${checkedInText(b)}</dd>` : ''}
      <dt>Created</dt><dd>${fmtDateTime(b.created_at)}</dd>
    </dl>
    ${b.status === 'confirmed' ? `
      <div class="manual-checkin">
        <p class="muted small">Driver can't show their QR code? Check their ID matches the name above, then check them in here.</p>
        <p class="error" id="manual-error"></p>
        <div class="actions start"><button class="btn primary" id="manual-checkin">Check in manually</button></div>
      </div>` : ''}
    <h3 class="section-title">Payments</h3>
    ${paymentList(b.payments, money)}`;
  if (!dialog.open) dialog.showModal();

  $('#manual-checkin')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!confirm(`Check in ${b.user_name} to slot ${b.slot_label} without their QR code?`)) return;
    btn.disabled = true;
    try {
      await api(`/api/admin/bookings/${b.id}/checkin`, { method: 'POST' });
      state.bookingsLoaded = false;
      showBooking(b.id);
    } catch (err) {
      $('#manual-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- init

async function init() {
  state.config = await request('/api/config');
  if (state.token) {
    try {
      state.user = (await api('/api/admin/auth/me')).user;
    } catch {
      state.token = null;
      storage.set(TOKEN_KEY, null);
    }
  }
  render();
}

init().catch((err) => {
  document.querySelector('main').innerHTML = `<p class="error narrow">Could not start the admin portal: ${esc(err.message)}</p>`;
});
