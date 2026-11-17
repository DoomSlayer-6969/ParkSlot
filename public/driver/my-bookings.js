// "My bookings": upcoming bookings and the paged history, each booking's details (receipt), and
// cancelling with a refund.
import { $, esc, fmtDateTime, paymentList, statusBadge } from '../common.js';
import { refreshSpot } from './finder.js';
import { openModal } from './modal.js';
import { showPass } from './pass.js';
import { api, money } from './session.js';

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
        ${statusBadge(b.status)}
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

/** Upcoming bookings, or the paged history of past ones. */
export function showMyBookings(tab = 'upcoming') {
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
  const backHere = () => showMyBookings(tab);
  $('#modal-body').querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => { if (btn.dataset.tab !== tab) showMyBookings(btn.dataset.tab); };
  });

  list.onclick = async (e) => {
    const passBtn = e.target.closest('[data-pass]');
    if (passBtn) return showPass(Number(passBtn.dataset.pass), { onBack: backHere });
    const receiptBtn = e.target.closest('[data-receipt]');
    if (receiptBtn) return showReceipt(Number(receiptBtn.dataset.receipt), backHere);
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

/** One booking with its payment trail. `onBack` returns to the list it was opened from. */
async function showReceipt(bookingId, onBack) {
  const back = '<button class="link" id="receipt-back">← My bookings</button>';
  let b;
  try {
    b = await api(`/api/bookings/${bookingId}`);
  } catch (err) {
    openModal(`${back}<p class="error">${esc(err.message)}</p>`, refreshSpot);
    $('#receipt-back').onclick = onBack;
    return;
  }

  openModal(`
    ${back}
    <h2>Booking details</h2>
    ${b.status === 'confirmed' ? '<div class="actions start"><button class="btn primary small" id="receipt-pass">Show QR code</button></div>' : ''}
    <dl class="summary">
      <dt>Status</dt><dd>${statusBadge(b.status)}</dd>
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
  $('#receipt-back').onclick = onBack;
  $('#receipt-pass')?.addEventListener('click', () => showPass(b.id, { onBack }));
}
