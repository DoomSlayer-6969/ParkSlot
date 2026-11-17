// The booking flow: confirm the window, hold the slot while paying, pay online, then show the QR pass.
import { $, esc, fmtDateTime } from '../common.js';
import { showAuth } from './account.js';
import { currentSpot, refreshSpot } from './finder.js';
import { closeModal, openModal, repeatWhileOpen, setModalOnClose } from './modal.js';
import { showPass } from './pass.js';
import { api, money, session } from './session.js';

/** Books a free slot of the open spot: confirm the window, hold the slot, then pay. */
export function startBooking(slotId) {
  if (!session.user) return showAuth(() => startBooking(slotId));
  const s = currentSpot();
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
      setModalOnClose(refreshSpot);
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
  let stopTimer = () => {};
  const tick = () => {
    const left = booking.hold_expires_at - Date.now();
    if (left <= 0) {
      $('#hold-timer').textContent = 'Your reservation expired. Close this and pick the slot again.';
      payBtn.disabled = true;
      stopTimer();
      return;
    }
    const mins = Math.floor(left / 60_000);
    const secs = String(Math.floor(left / 1000) % 60).padStart(2, '0');
    $('#hold-timer').textContent = `Slot reserved for you for ${mins}:${secs}`;
  };
  stopTimer = repeatWhileOpen(tick, 1000);
  tick();

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
      if (payBtn.disabled) setModalOnClose(refreshSpot);
    }
  };
}

function showSuccess(booking) {
  showPass(booking.id, { heading: 'Booking confirmed' });
}
