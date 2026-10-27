import { $, esc, fmtDateTime, fmtTime, money as formatMoney, request, STATUS_TEXT, storage } from './common.js';

const SEARCH_RADIUS_KM = 3;
const HOUR_MS = 3_600_000;

const state = {
  config: null,
  token: storage.get('token'),
  user: null,
  center: null,
  spots: [],
  spot: null, // spot currently open in the panel, with slot statuses
  modalOnClose: null,
  timer: null,
};

const money = (amount) => formatMoney(amount, state.config.currency);

function api(path, options = {}) {
  const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
  return request(path, { ...options, headers }).catch((err) => {
    if (err.status === 401 && state.user) setSession(null, null);
    throw err;
  });
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  storage.set('token', token);
  renderAuthArea();
}

// ---------------------------------------------------------------- modal

const dialog = $('#modal');

function openModal(html, onClose = null) {
  clearInterval(state.timer);
  $('#modal-body').innerHTML = html;
  state.modalOnClose = onClose;
  if (!dialog.open) dialog.showModal();
}

function closeModal() {
  dialog.close();
}

dialog.addEventListener('close', () => {
  clearInterval(state.timer);
  const onClose = state.modalOnClose;
  state.modalOnClose = null;
  onClose?.();
});
dialog.addEventListener('click', (e) => { if (e.target === dialog) closeModal(); });
$('#modal-close').addEventListener('click', closeModal);

// ---------------------------------------------------------------- map

const map = L.map('map', { zoomControl: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const spotLayer = L.layerGroup().addTo(map);
const centerLayer = L.layerGroup().addTo(map);

map.on('click', (e) => setCenter(e.latlng.lat, e.latlng.lng));

function drawCenter() {
  centerLayer.clearLayers();
  const { lat, lng } = state.center;
  L.circle([lat, lng], { radius: SEARCH_RADIUS_KM * 1000, color: '#2563eb', weight: 1, fillOpacity: 0.04, interactive: false }).addTo(centerLayer);
  L.circleMarker([lat, lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 })
    .bindTooltip('Your destination').addTo(centerLayer);
}

function drawSpots() {
  spotLayer.clearLayers();
  for (const spot of state.spots) {
    const selected = state.spot?.id === spot.id;
    L.circleMarker([spot.lat, spot.lng], {
      radius: selected ? 12 : 9,
      color: selected ? '#111827' : '#fff',
      weight: 2,
      fillColor: spot.free_slots ? '#16a34a' : '#dc2626',
      fillOpacity: 0.95,
    })
      .bindTooltip(`${esc(spot.name)} · ${spot.free_slots}/${spot.total_slots} free`)
      .on('click', (e) => { L.DomEvent.stopPropagation(e); openSpot(spot.id); })
      .addTo(spotLayer);
  }
}

// ---------------------------------------------------------------- search

async function setCenter(lat, lng, zoom) {
  state.center = { lat, lng };
  state.spot = null;
  drawCenter();
  if (zoom) map.setView([lat, lng], zoom);
  $('#results').innerHTML = '<p class="muted">Looking for parking nearby…</p>';
  try {
    const { spots } = await api(`/api/spots?lat=${lat}&lng=${lng}&radius=${SEARCH_RADIUS_KM}`);
    state.spots = spots;
    renderSpotList();
  } catch (err) {
    $('#results').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
  drawSpots();
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) return;
  $('#results').innerHTML = '<p class="muted">Finding that place…</p>';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`);
    const [hit] = await res.json();
    if (!hit) throw new Error('We could not find that place. Try a more specific name, or click on the map.');
    setCenter(Number(hit.lat), Number(hit.lon), 15);
  } catch (err) {
    $('#results').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
});

$('#locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => setCenter(pos.coords.latitude, pos.coords.longitude, 15),
    () => { $('#results').innerHTML = '<p class="error">Could not get your location.</p>'; },
  );
});

// ---------------------------------------------------------------- booking window

function toLocalInput(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The window the user wants to park for. A start time not in the future means "now". */
function readWindow() {
  const value = $('#start-input').value;
  const chosen = value ? new Date(value).getTime() : Date.now();
  const hours = Math.min(Math.max(Math.round(Number($('#hours-input').value) || 1), 1), state.config.maxHours);
  return { startAt: Math.max(chosen, Date.now()), hours };
}

for (const id of ['#start-input', '#hours-input']) {
  $(id).addEventListener('change', () => { if (state.spot) openSpot(state.spot.id); });
}

// ---------------------------------------------------------------- results panel

function renderSpotList() {
  const results = $('#results');
  if (!state.spots.length) {
    results.innerHTML = `<p class="empty">No parking spots within ${SEARCH_RADIUS_KM} km of this point. Try somewhere else on the map.</p>`;
    return;
  }
  results.innerHTML = `
    <h2 class="section-title">${state.spots.length} parking spots nearby</h2>
    <ul class="spot-list">
      ${state.spots.map((s) => `
        <li>
          <button class="spot-item" data-spot="${s.id}">
            <span class="spot-main">
              <b>${esc(s.name)}</b>
              <span class="muted small">${esc(s.address)}</span>
            </span>
            <span class="spot-meta">
              <span class="badge ${s.free_slots ? 'ok' : 'full'}">${s.free_slots}/${s.total_slots} free</span>
              <span class="muted small">${s.distance_km.toFixed(1)} km · ${money(s.hourly_rate)}/h</span>
            </span>
          </button>
        </li>`).join('')}
    </ul>`;
}

async function openSpot(spotId) {
  const { startAt, hours } = readWindow();
  try {
    state.spot = await api(`/api/spots/${spotId}?start=${startAt}&hours=${hours}`);
  } catch (err) {
    $('#results').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  renderSpot();
  drawSpots();
}

const refreshSpot = () => { if (state.spot) openSpot(state.spot.id); };

function slotTitle(slot) {
  if (!slot.upcoming.length) return 'No upcoming bookings';
  return slot.upcoming.map((b) => `Booked ${fmtDateTime(b.start_at)} – ${fmtTime(b.end_at)}`).join('\n');
}

function renderSpot() {
  const s = state.spot;
  const count = (status) => s.slots.filter((slot) => slot.status === status).length;
  $('#results').innerHTML = `
    <button class="link" data-action="back">← All nearby spots</button>
    <div class="spot-head">
      <h2>${esc(s.name)}</h2>
      <p class="muted small">${esc(s.address)}</p>
      <p><b>${money(s.hourly_rate)}</b> per hour</p>
    </div>
    <p class="muted small">Availability for <b>${fmtDateTime(s.window.start_at)} – ${fmtTime(s.window.end_at)}</b> (${s.window.hours} h)</p>
    <div class="legend">
      <span class="chip free">${count('free')} free</span>
      <span class="chip booked">${count('booked')} booked</span>
      <span class="chip occupied">${count('occupied')} occupied</span>
    </div>
    <div class="slot-grid">
      ${s.slots.map((slot) => `
        <button class="slot ${slot.status}" data-slot="${slot.id}" title="${esc(slotTitle(slot))}"
                ${slot.status === 'free' ? '' : 'aria-disabled="true"'}>
          ${esc(slot.label)}<small>${STATUS_TEXT[slot.status]}</small>
        </button>`).join('')}
    </div>
    <p class="muted small">Tap a free slot to book it. Hover a slot to see its upcoming bookings.</p>`;
}

$('#results').addEventListener('click', (e) => {
  const spotBtn = e.target.closest('[data-spot]');
  if (spotBtn) return openSpot(Number(spotBtn.dataset.spot));
  const slotBtn = e.target.closest('.slot.free');
  if (slotBtn) return startBooking(Number(slotBtn.dataset.slot));
  if (e.target.closest('[data-action="back"]')) {
    state.spot = null;
    renderSpotList();
    drawSpots();
  }
});

// ---------------------------------------------------------------- booking flow

function startBooking(slotId) {
  if (!state.user) return showAuth(() => startBooking(slotId));
  const s = state.spot;
  const slot = s.slots.find((x) => x.id === slotId);
  const hours = s.window.hours;

  openModal(`
    <h2>Book slot ${esc(slot.label)}</h2>
    <p class="muted">${esc(s.name)}</p>
    <dl class="summary">
      <dt>From</dt><dd>${fmtDateTime(s.window.start_at)}</dd>
      <dt>Until</dt><dd>${fmtDateTime(s.window.end_at)}</dd>
      <dt>Duration</dt><dd>${hours} h × ${money(s.hourly_rate)}</dd>
      <dt>Total</dt><dd><b>${money(hours * s.hourly_rate)}</b></dd>
    </dl>
    <p class="muted small">You can arrive any time within this window. Payment is online only.</p>
    <p class="error" id="book-error"></p>
    <div class="actions">
      <button class="btn ghost" id="book-cancel">Cancel</button>
      <button class="btn primary" id="book-confirm">Continue to payment</button>
    </div>`);

  $('#book-cancel').onclick = closeModal;
  $('#book-confirm').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const booking = await api('/api/bookings', {
        method: 'POST',
        body: { slotId, startAt: s.window.start_at, hours },
      });
      showPayment(booking);
    } catch (err) {
      $('#book-error').textContent = err.message;
      state.modalOnClose = refreshSpot;
    }
  };
}

function showPayment(booking) {
  const releaseHold = () => api(`/api/bookings/${booking.id}/cancel`, { method: 'POST' }).catch(() => {}).finally(refreshSpot);

  openModal(`
    <h2>Pay online</h2>
    <p class="muted">Slot <b>${esc(booking.slot_label)}</b> at ${esc(booking.spot_name)}<br>
      ${fmtDateTime(booking.start_at)} – ${fmtDateTime(booking.end_at)}</p>
    <p class="total">Total <b>${money(booking.amount)}</b> <span class="muted">(${booking.hours} h)</span></p>
    <p class="hold" id="hold-timer"></p>
    <form id="pay-form" class="form" autocomplete="on">
      <label>Name on card <input name="name" required autocomplete="cc-name"></label>
      <label>Card number <input name="number" required inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242"></label>
      <div class="row">
        <label>Expiry <input name="expiry" required placeholder="MM/YY" autocomplete="cc-exp"></label>
        <label>CVC <input name="cvc" required inputmode="numeric" autocomplete="cc-csc" placeholder="123"></label>
      </div>
      <p class="error" id="pay-error"></p>
      <div class="actions">
        <button type="button" class="btn ghost" id="pay-cancel">Cancel</button>
        <button class="btn primary" id="pay-btn">Pay ${money(booking.amount)}</button>
      </div>
    </form>
    <p class="muted small">Demo gateway: use 4242 4242 4242 4242 to succeed or 4000 0000 0000 0002 to be declined, with any future expiry.</p>`,
  releaseHold);

  const payBtn = $('#pay-btn');
  const tick = () => {
    const left = booking.hold_expires_at - Date.now();
    if (left <= 0) {
      $('#hold-timer').textContent = 'Your reservation expired. Close this and pick the slot again.';
      payBtn.disabled = true;
      clearInterval(state.timer);
      return;
    }
    const mins = Math.floor(left / 60_000);
    const secs = String(Math.floor(left / 1000) % 60).padStart(2, '0');
    $('#hold-timer').textContent = `Slot reserved for you for ${mins}:${secs}`;
  };
  tick();
  state.timer = setInterval(tick, 1000);

  $('#pay-cancel').onclick = closeModal;
  $('#pay-form').onsubmit = async (e) => {
    e.preventDefault();
    payBtn.disabled = true;
    payBtn.textContent = 'Processing…';
    try {
      const card = Object.fromEntries(new FormData(e.target));
      showSuccess(await api(`/api/bookings/${booking.id}/pay`, { method: 'POST', body: { card } }));
    } catch (err) {
      $('#pay-error').textContent = err.message;
      payBtn.textContent = `Pay ${money(booking.amount)}`;
      payBtn.disabled = err.status === 409 || err.status === 410; // booking can no longer be paid
      if (payBtn.disabled) state.modalOnClose = refreshSpot;
    }
  };
}

function showSuccess(booking) {
  openModal(`
    <h2>Booking confirmed</h2>
    <p class="muted">Your booking ID</p>
    <div class="code-box"><span class="code">${esc(booking.code)}</span><button class="btn ghost small" id="copy-code">Copy</button></div>
    <p>Show this ID at the entrance of <b>${esc(booking.spot_name)}</b>. You can arrive any time between
      <b>${fmtDateTime(booking.start_at)}</b> and <b>${fmtDateTime(booking.end_at)}</b>.</p>
    <dl class="summary">
      <dt>Slot</dt><dd>${esc(booking.slot_label)}</dd>
      <dt>Paid</dt><dd>${money(booking.amount)}</dd>
    </dl>
    <div class="actions"><button class="btn primary" id="done-btn">Done</button></div>`,
  refreshSpot);

  $('#copy-code').onclick = (e) => {
    navigator.clipboard?.writeText(booking.code).then(() => { e.target.textContent = 'Copied'; }, () => {});
  };
  $('#done-btn').onclick = closeModal;
}

// ---------------------------------------------------------------- my bookings

async function showMyBookings() {
  let bookings;
  try {
    ({ bookings } = await api('/api/bookings'));
  } catch (err) {
    return openModal(`<h2>My bookings</h2><p class="error">${esc(err.message)}</p>`);
  }
  const visible = bookings.filter((b) => b.status !== 'expired' && !(b.status === 'cancelled' && !b.code));

  openModal(`
    <h2>My bookings</h2>
    ${visible.length ? '' : '<p class="muted">You have no bookings yet.</p>'}
    <ul class="booking-list">
      ${visible.map((b) => `
        <li class="booking ${b.status}">
          <div class="booking-head">
            <span class="code">${esc(b.code ?? '—')}</span>
            <span class="badge status-${b.status}">${STATUS_TEXT[b.status]}</span>
          </div>
          <div><b>${esc(b.spot_name)}</b> · Slot ${esc(b.slot_label)}</div>
          <div class="muted small">${fmtDateTime(b.start_at)} – ${fmtDateTime(b.end_at)} · ${money(b.amount)}</div>
          ${b.status === 'confirmed' && b.start_at > Date.now()
            ? `<button class="btn ghost small" data-cancel="${b.id}">Cancel &amp; refund</button>` : ''}
        </li>`).join('')}
    </ul>`, refreshSpot);

  $('#modal-body').querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Cancel this booking? The full amount will be refunded.')) return;
      btn.disabled = true;
      try {
        await api(`/api/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST' });
        showMyBookings();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    };
  });
}

// ---------------------------------------------------------------- auth

function renderAuthArea() {
  const area = $('#auth-area');
  if (state.user) {
    area.innerHTML = `
      <span class="who">Hi, ${esc(state.user.name)}</span>
      <button class="btn ghost" id="bookings-btn">My bookings</button>
      <button class="btn ghost" id="logout-btn">Log out</button>`;
    $('#bookings-btn').onclick = showMyBookings;
    $('#logout-btn').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
    };
  } else {
    area.innerHTML = '<button class="btn primary" id="login-btn">Log in</button>';
    $('#login-btn').onclick = () => showAuth();
  }
}

function showAuth(onDone, mode = 'login') {
  const isLogin = mode === 'login';
  openModal(`
    <h2>${isLogin ? 'Log in' : 'Create an account'}</h2>
    ${onDone ? '<p class="muted small">Log in to book this slot.</p>' : ''}
    <form id="auth-form" class="form">
      ${isLogin ? '' : '<label>Name <input name="name" required autocomplete="name"></label>'}
      <label>Email <input name="email" type="email" required autocomplete="email"></label>
      <label>Password <input name="password" type="password" required minlength="8"
        autocomplete="${isLogin ? 'current-password' : 'new-password'}"></label>
      <p class="error" id="auth-error"></p>
      <div class="actions"><button class="btn primary">${isLogin ? 'Log in' : 'Sign up'}</button></div>
    </form>
    <p class="muted small">
      ${isLogin
        ? 'No account? <a href="#" id="auth-switch">Sign up</a><br>Demo account: demo@parking.test / demo1234'
        : 'Already have an account? <a href="#" id="auth-switch">Log in</a>'}
    </p>`);

  $('#auth-switch').onclick = (e) => {
    e.preventDefault();
    showAuth(onDone, isLogin ? 'register' : 'login');
  };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const { token, user } = await api(`/api/auth/${isLogin ? 'login' : 'register'}`, { method: 'POST', body });
      setSession(token, user);
      if (onDone) onDone(); // continues in the same dialog
      else closeModal();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  };
}

// ---------------------------------------------------------------- init

async function init() {
  state.config = await api('/api/config');
  if (state.token) {
    try {
      state.user = (await api('/api/auth/me')).user;
    } catch {
      state.token = null;
      storage.set('token', null);
    }
  }
  renderAuthArea();

  const startInput = $('#start-input');
  startInput.value = toLocalInput(new Date());
  startInput.min = toLocalInput(new Date());
  startInput.max = toLocalInput(new Date(Date.now() + state.config.maxAdvanceDays * 24 * HOUR_MS));
  $('#hours-input').max = state.config.maxHours;

  const { lat, lng } = state.config.defaultCenter;
  setCenter(lat, lng, 14);
}

init().catch((err) => {
  $('#results').innerHTML = `<p class="error">Could not start the app: ${esc(err.message)}</p>`;
});
