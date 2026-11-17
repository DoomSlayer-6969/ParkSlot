// The Bookings panel: search every booking, open one's details, and check a driver in manually when they
// cannot show their QR code.
import { $, esc, fmtDateTime, paymentList, STATUS_TEXT, statusBadge } from '../common.js';
import { api, money } from './session.js';

const CHECKED_IN_BY = { qr: 'QR scan', manual: 'manually' };

export function checkedInText(b) {
  const how = CHECKED_IN_BY[b.checkin_method];
  return `${fmtDateTime(b.checked_in_at)}${how ? ` · ${how}` : ''}${b.checked_in_by_name ? ` by ${esc(b.checked_in_by_name)}` : ''}`;
}

/** The booking summary shown after a scan. */
export function bookingDetails(b) {
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
let loaded = false; // whether the table shows current data

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
    loaded = true;
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
  if (!loaded && !$('#bookings-panel').hidden) searchBookings(); // a booking was checked in
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
      loaded = false;
      showBooking(b.id);
    } catch (err) {
      $('#manual-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

/** Marks the table as out of date (e.g. a scan changed a status), so it reloads when next shown. */
export function markBookingsStale() {
  loaded = false;
}

/** Called when the panel is shown: loads the table unless it is current. */
export function showBookingsPanel() {
  if (!loaded) searchBookings();
}

/** Clears the table (on sign-out). */
export function resetBookings() {
  loaded = false;
  $('#bookings-body').innerHTML = '';
}
