import { $, esc, fmtDateTime, request, STATUS_TEXT, storage } from './common.js';

const form = $('#checkin-form');
form.key.value = storage.get('attendantKey') ?? '';

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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = form.key.value;
  storage.set('attendantKey', key);
  const result = $('#result');
  try {
    const booking = await request('/api/checkin', {
      method: 'POST',
      headers: { 'x-attendant-key': key },
      body: { code: form.code.value },
    });
    result.innerHTML = `<div class="card result ok"><h2>Checked in — direct the driver to slot ${esc(booking.slot_label)}</h2>${bookingDetails(booking)}</div>`;
    form.code.value = '';
  } catch (err) {
    const booking = err.data?.booking;
    result.innerHTML = `<div class="card result bad"><h2>${esc(err.message)}</h2>${booking ? bookingDetails(booking) : ''}</div>`;
  }
});
