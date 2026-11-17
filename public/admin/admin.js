import { $, esc, fmtDateTime, money as formatMoney, paymentList, request, STATUS_TEXT, storage } from '../common.js';

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
    $('#logout-btn').onclick = async () => {
      await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
    };
  } else {
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
  if (name === 'bookings' && !state.bookingsLoaded) searchBookings();
}

for (const tab of document.querySelectorAll('[data-panel]')) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
}

// ---------------------------------------------------------------- check-in

function bookingDetails(b) {
  return `
    <dl class="summary">
      <dt>Booking</dt><dd class="code">${esc(b.code)}</dd>
      <dt>Spot</dt><dd>${esc(b.spot_name)}</dd>
      <dt>Slot</dt><dd><b>${esc(b.slot_label)}</b></dd>
      <dt>Window</dt><dd>${fmtDateTime(b.start_at)} – ${fmtDateTime(b.end_at)}</dd>
      <dt>Status</dt><dd>${STATUS_TEXT[b.status] ?? esc(b.status)}</dd>
    </dl>`;
}

$('#checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const result = $('#checkin-result');
  try {
    const booking = await api('/api/admin/checkin', { method: 'POST', body: { code: form.code.value } });
    result.innerHTML = `<div class="card result ok"><h2>Checked in — direct the driver to slot ${esc(booking.slot_label)}</h2>${bookingDetails(booking)}</div>`;
    form.code.value = '';
    state.bookingsLoaded = false; // statuses changed
  } catch (err) {
    const booking = err.data?.booking;
    result.innerHTML = `<div class="card result bad"><h2>${esc(err.message)}</h2>${booking ? bookingDetails(booking) : ''}</div>`;
  }
});

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
      ${b.checked_in_at ? `<dt>Checked in</dt><dd>${fmtDateTime(b.checked_in_at)}</dd>` : ''}
      <dt>Created</dt><dd>${fmtDateTime(b.created_at)}</dd>
    </dl>
    <h3 class="section-title">Payments</h3>
    ${paymentList(b.payments, money)}`;
  if (!dialog.open) dialog.showModal();
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
