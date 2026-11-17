// The booking's QR pass: drivers show it at the entrance and staff scan it to check them in.
import { $, esc, fmtDateTime } from '../common.js';
import { refreshSpot } from './finder.js';
import { closeModal, openModal } from './modal.js';
import { api } from './session.js';

/**
 * Shows the pass of a paid booking. `onBack`, when given, adds a "← My bookings" link that calls it.
 */
export async function showPass(bookingId, { heading = 'Your parking pass', onBack = null } = {}) {
  const back = onBack ? '<button class="link" id="pass-back">← My bookings</button>' : '';
  const wireBack = () => { if (onBack) $('#pass-back').onclick = onBack; };
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
