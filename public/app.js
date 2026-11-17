import { $, esc, fmtDateTime, fmtTime, money as formatMoney, paymentList, request, STATUS_TEXT, storage } from './common.js';

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
  showPass(booking.id, { heading: 'Booking confirmed' });
}

// ---------------------------------------------------------------- QR pass

/** The booking's QR pass: drivers show it at the entrance and staff scan it to check them in. */
async function showPass(bookingId, { heading = 'Your parking pass', backTab = null } = {}) {
  const back = backTab ? '<button class="link" id="pass-back">← My bookings</button>' : '';
  const wireBack = () => { if (backTab) $('#pass-back').onclick = () => showMyBookings(backTab); };
  let booking;
  let src;
  try {
    const [details, svg] = await Promise.all([api(`/api/bookings/${bookingId}`), api(`/api/bookings/${bookingId}/qr`)]);
    booking = details;
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch (err) {
    openModal(`${back}<p class="error">${esc(err.message)}</p>`, refreshSpot);
    wireBack();
    return;
  }

  openModal(`
    ${back}
    <h2>${esc(heading)}</h2>
    <p class="muted">Slot <b>${esc(booking.slot_label)}</b> at ${esc(booking.spot_name)}</p>
    <figure class="qr-pass">
      <img src="${esc(src)}" alt="Check-in QR code for slot ${esc(booking.slot_label)}" width="260" height="260">
    </figure>
    <p>Show this QR code at the entrance of <b>${esc(booking.spot_name)}</b> and staff will scan it to let you in.
      You can arrive any time between <b>${fmtDateTime(booking.start_at)}</b> and <b>${fmtDateTime(booking.end_at)}</b>.</p>
    <p class="muted small">Save it in case there's no signal at the car park, and turn your screen brightness up if it
      doesn't scan. It works once, so don't share it. You can open it again from <b>My bookings</b>.</p>
    <p class="error" id="pass-error"></p>
    <div class="actions">
      <button class="btn ghost" id="pass-save">Save image</button>
      <button class="btn primary" id="pass-done">Done</button>
    </div>`,
  refreshSpot);

  wireBack();
  $('#pass-done').onclick = closeModal;
  $('#pass-save').onclick = () => savePassImage(src, booking).catch(() => {
    $('#pass-error').textContent = 'Could not save the image. Take a screenshot instead.';
  });
}

/** Downloads the pass as a PNG with the booking details under the QR code, for showing offline. */
async function savePassImage(src, booking) {
  const img = new Image();
  img.src = src;
  await img.decode();

  const size = 720;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size + 170;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'center';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText(`ParkSlot · Slot ${booking.slot_label}`, size / 2, size + 30);
  ctx.font = '26px system-ui, sans-serif';
  ctx.fillText(booking.spot_name, size / 2, size + 78);
  ctx.fillText(`${fmtDateTime(booking.start_at)} – ${fmtDateTime(booking.end_at)}`, size / 2, size + 120);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png');
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `parkslot-pass-${booking.slot_label}-${booking.id}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// ---------------------------------------------------------------- my bookings

const BOOKING_TABS = {
  upcoming: { label: 'Upcoming', empty: 'No upcoming bookings.' },
  history: { label: 'History', empty: 'No past bookings yet. Bookings you have used, missed or cancelled show up here.' },
};

function bookingItem(b) {
  const cancellable = b.status === 'confirmed' && b.start_at > Date.now();
  const hasPass = b.status === 'confirmed'; // paid, not used yet and not over
  return `
    <li class="booking ${b.status}">
      <div class="booking-head">
        <b>${esc(b.spot_name)}</b>
        <span class="badge status-${b.status}">${STATUS_TEXT[b.status] ?? esc(b.status)}</span>
      </div>
      <div>Slot ${esc(b.slot_label)} · ${money(b.amount)}</div>
      <div class="muted small">${fmtDateTime(b.start_at)} – ${fmtDateTime(b.end_at)}</div>
      ${b.code ? `
        <div class="booking-actions">
          ${hasPass ? `<button class="btn primary small" data-pass="${b.id}">Show QR code</button>` : ''}
          <button class="btn ghost small" data-receipt="${b.id}">Details</button>
          ${cancellable ? `<button class="btn ghost small" data-cancel="${b.id}">Cancel &amp; refund</button>` : ''}
        </div>` : ''}
    </li>`;
}

/** "My bookings": upcoming bookings, or the paged history of past ones. */
function showMyBookings(tab = 'upcoming') {
  openModal(`
    <h2>My bookings</h2>
    <div class="tabs" role="tablist">
      ${Object.entries(BOOKING_TABS).map(([key, t]) => `
        <button class="tab" role="tab" data-tab="${key}" aria-selected="${key === tab}">${t.label}</button>`).join('')}
    </div>
    <ul class="booking-list" id="booking-list"></ul>
    <p class="muted" id="bookings-status">Loading…</p>
    <div class="actions"><button class="btn ghost small" id="load-more" hidden>Load more</button></div>`,
  refreshSpot);

  const list = $('#booking-list');
  $('#modal-body').querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => { if (btn.dataset.tab !== tab) showMyBookings(btn.dataset.tab); };
  });

  list.onclick = async (e) => {
    const passBtn = e.target.closest('[data-pass]');
    if (passBtn) return showPass(Number(passBtn.dataset.pass), { backTab: tab });
    const receiptBtn = e.target.closest('[data-receipt]');
    if (receiptBtn) return showReceipt(Number(receiptBtn.dataset.receipt), tab);
    const cancelBtn = e.target.closest('[data-cancel]');
    if (!cancelBtn || !confirm('Cancel this booking? The full amount will be refunded.')) return;
    cancelBtn.disabled = true;
    try {
      await api(`/api/bookings/${cancelBtn.dataset.cancel}/cancel`, { method: 'POST' });
      showMyBookings(tab);
    } catch (err) {
      alert(err.message);
      cancelBtn.disabled = false;
    }
  };

  const loadPage = async (offset) => {
    const more = $('#load-more');
    more.disabled = true;
    try {
      const page = await api(`/api/bookings?scope=${tab}&offset=${offset}`);
      if (!list.isConnected) return; // the dialog moved on while this loaded
      list.insertAdjacentHTML('beforeend', page.bookings.map(bookingItem).join(''));
      $('#bookings-status').textContent = list.children.length ? '' : BOOKING_TABS[tab].empty;
      more.hidden = !page.has_more;
      more.onclick = () => loadPage(page.next_offset);
    } catch (err) {
      if (!list.isConnected) return;
      $('#bookings-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
    } finally {
      more.disabled = false;
    }
  };
  loadPage(0);
}

/** One booking with its payment trail. */
async function showReceipt(bookingId, backTab) {
  const back = '<button class="link" id="receipt-back">← My bookings</button>';
  let b;
  try {
    b = await api(`/api/bookings/${bookingId}`);
  } catch (err) {
    openModal(`${back}<p class="error">${esc(err.message)}</p>`, refreshSpot);
    $('#receipt-back').onclick = () => showMyBookings(backTab);
    return;
  }

  openModal(`
    ${back}
    <h2>Booking details</h2>
    ${b.status === 'confirmed' ? '<div class="actions start"><button class="btn primary small" id="receipt-pass">Show QR code</button></div>' : ''}
    <dl class="summary">
      <dt>Status</dt><dd><span class="badge status-${b.status}">${STATUS_TEXT[b.status] ?? esc(b.status)}</span></dd>
      <dt>Spot</dt><dd>${esc(b.spot_name)}<br><span class="muted small">${esc(b.spot_address)}</span></dd>
      <dt>Slot</dt><dd>${esc(b.slot_label)}</dd>
      <dt>Window</dt><dd>${fmtDateTime(b.start_at)} – ${fmtDateTime(b.end_at)} (${b.hours} h)</dd>
      ${b.checked_in_at ? `<dt>Checked in</dt><dd>${fmtDateTime(b.checked_in_at)}</dd>` : ''}
      <dt>Booked on</dt><dd>${fmtDateTime(b.created_at)}</dd>
      <dt>Reference</dt><dd><span class="code">${esc(b.code)}</span>
        <br><span class="muted small">Quote this if you contact support. You need the QR code to get in.</span></dd>
    </dl>
    <h3 class="section-title">Payments</h3>
    ${paymentList(b.payments, money)}`,
  refreshSpot);
  $('#receipt-back').onclick = () => showMyBookings(backTab);
  $('#receipt-pass')?.addEventListener('click', () => showPass(b.id, { backTab }));
}

// ---------------------------------------------------------------- auth

function renderAuthArea() {
  const area = $('#auth-area');
  if (state.user) {
    area.innerHTML = `
      <span class="who">Hi, ${esc(state.user.name)}</span>
      <button class="btn ghost" id="bookings-btn">My bookings</button>
      <button class="btn ghost" id="logout-btn">Log out</button>`;
    $('#bookings-btn').onclick = () => showMyBookings();
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
      ${isLogin ? '<a href="#" class="small inline-link" id="forgot-link">Forgot password?</a>' : ''}
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
  if (isLogin) {
    $('#forgot-link').onclick = (e) => {
      e.preventDefault();
      showForgotPassword(onDone, $('#auth-form').email.value);
    };
  }
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

// ---------------------------------------------------------------- password reset

/** Step 1: ask for a reset link by email. */
function showForgotPassword(onDone, email = '') {
  openModal(`
    <h2>Reset your password</h2>
    <p class="muted small">Enter your account's email and we'll send you a link to choose a new password.</p>
    <form id="forgot-form" class="form">
      <label>Email <input name="email" type="email" required autocomplete="email" value="${esc(email)}"></label>
      <p class="error" id="forgot-error"></p>
      <div class="actions">
        <button type="button" class="btn ghost" id="forgot-back">Back to log in</button>
        <button class="btn primary" id="forgot-send">Send reset link</button>
      </div>
    </form>`);

  $('#forgot-back').onclick = () => showAuth(onDone);
  $('#forgot-form').onsubmit = async (e) => {
    e.preventDefault();
    const sendBtn = $('#forgot-send');
    sendBtn.disabled = true;
    try {
      const { message } = await api('/api/auth/password-reset/request', {
        method: 'POST',
        body: { email: e.target.email.value },
      });
      openModal(`
        <h2>Check your email</h2>
        <p>${esc(message)}</p>
        <p class="muted small">The link works once and expires in ${state.config.resetTokenMinutes} minutes.
          If nothing arrives, check your spam folder or try again in a minute.</p>
        <p class="muted small">Prototype: emails are printed in the server console instead of being sent.</p>
        <div class="actions"><button class="btn primary" id="forgot-done">Back to log in</button></div>`);
      $('#forgot-done').onclick = () => showAuth(onDone);
    } catch (err) {
      $('#forgot-error').textContent = err.message;
      sendBtn.disabled = false;
    }
  };
}

/** Step 2: the emailed link opens the app at /#reset=<token>. */
function showResetPassword(token) {
  openModal(`
    <h2>Choose a new password</h2>
    <form id="reset-form" class="form">
      <label>New password <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Confirm new password <input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>
      <p class="error" id="reset-error"></p>
      <div class="actions"><button class="btn primary" id="reset-btn">Set new password</button></div>
    </form>
    <p class="muted small">This signs you out on every other device.</p>`);

  $('#reset-form').onsubmit = async (e) => {
    e.preventDefault();
    const { password, confirm } = Object.fromEntries(new FormData(e.target));
    const error = $('#reset-error');
    if (password !== confirm) {
      error.textContent = 'The two passwords do not match.';
      return;
    }
    $('#reset-btn').disabled = true;
    try {
      const session = await api('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      setSession(session.token, session.user);
      openModal(`
        <h2>Password updated</h2>
        <p>You're logged in as <b>${esc(session.user.email)}</b>.</p>
        <div class="actions"><button class="btn primary" id="reset-done">Done</button></div>`);
      $('#reset-done').onclick = closeModal;
    } catch (err) {
      error.innerHTML = `${esc(err.message)}${err.data?.reason === 'invalid_reset_token'
        ? ' <a href="#" id="reset-again">Request a new link</a>' : ''}`;
      $('#reset-again')?.addEventListener('click', (ev) => { ev.preventDefault(); showForgotPassword(null); });
      $('#reset-btn').disabled = false;
    }
  };
}

/** Takes a reset token from the URL and removes it, so it is not left in the address bar or history. */
function takeResetToken() {
  const token = new URLSearchParams(location.hash.slice(1)).get('reset');
  if (token) history.replaceState(null, '', location.pathname + location.search);
  return token;
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

  const openResetFromUrl = () => {
    const resetToken = takeResetToken();
    if (resetToken) showResetPassword(resetToken);
  };
  openResetFromUrl();
  // A reset link pasted into a tab that already has the app open only changes the hash.
  window.addEventListener('hashchange', openResetFromUrl);
}

init().catch((err) => {
  $('#results').innerHTML = `<p class="error">Could not start the app: ${esc(err.message)}</p>`;
});
