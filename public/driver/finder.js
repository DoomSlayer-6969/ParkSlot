// Finding parking: the map, place search, the arrival window, the list of nearby spots, and one spot's
// slots. Choosing a free slot is handed to `onSlotSelected` (the booking flow) given to initFinder().
import { $, esc, fmtDateTime, fmtTime, STATUS_TEXT } from '../common.js';
import { api, money, session } from './session.js';

const SEARCH_RADIUS_KM = 3;
const HOUR_MS = 3_600_000;

const state = {
  center: null,
  spots: [],
  spot: null, // spot currently open in the panel, with slot statuses
  onSlotSelected: () => {},
};

/** The spot open in the panel (with its window and slot statuses), or null. */
export const currentSpot = () => state.spot;

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
  const hours = Math.min(Math.max(Math.round(Number($('#hours-input').value) || 1), 1), session.config.maxHours);
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

/** Reloads the open spot's slot statuses (after a booking, a cancellation, or a hold being released). */
export function refreshSpot() {
  if (state.spot) openSpot(state.spot.id);
}

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
  if (slotBtn) return state.onSlotSelected(Number(slotBtn.dataset.slot));
  if (e.target.closest('[data-action="back"]')) {
    state.spot = null;
    renderSpotList();
    drawSpots();
  }
});

// ---------------------------------------------------------------- init

/** Sets the arrival window's limits and shows parking around the default centre. Needs session.config. */
export function initFinder({ onSlotSelected }) {
  state.onSlotSelected = onSlotSelected;
  const startInput = $('#start-input');
  startInput.value = toLocalInput(new Date());
  startInput.min = toLocalInput(new Date());
  startInput.max = toLocalInput(new Date(Date.now() + session.config.maxAdvanceDays * 24 * HOUR_MS));
  $('#hours-input').max = session.config.maxHours;

  const { lat, lng } = session.config.defaultCenter;
  setCenter(lat, lng, 14);
}
