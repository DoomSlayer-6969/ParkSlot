// The Check-in panel. Staff scan the QR pass on the driver's phone, with this device's camera or a handheld
// (USB/Bluetooth) scanner, which types the QR code's text into the input followed by Enter.
import { $, esc } from '../common.js';
import { bookingDetails, markBookingsStale } from './bookings.js';
import { startScanner } from './scanner.js';
import { api, session } from './session.js';

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
    markBookingsStale(); // statuses changed
  } catch (err) {
    const booking = err.data?.booking;
    result.innerHTML = `<div class="card result bad"><h2>${esc(err.message)}</h2>${booking ? bookingDetails(booking) : ''}</div>`;
    navigator.vibrate?.([80, 60, 80]);
  } finally {
    scan.busy = false;
  }
}

export function focusScanInput() {
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

export function stopCamera() {
  if (!scan.stop) return; // not running (keeps any message in the status line)
  scan.stop();
  scan.stop = null;
  setCameraUi(false);
}

$('#camera-btn').addEventListener('click', async (e) => {
  if (scan.stop) {
    stopCamera();
    return;
  }
  if (!window.isSecureContext) {
    $('#scanner-status').innerHTML = insecureContextHint();
    return;
  }
  const btn = e.currentTarget;
  btn.disabled = true;
  setCameraUi(true, 'Starting the camera… If the browser asks, allow camera access.');
  try {
    const stop = await startScanner($('#scanner-video'), (text) => submitScan(text, { fromCamera: true }));
    if (!session.user || $('#checkin-panel').hidden) {
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

/**
 * Browsers only allow the camera on https:// or http://localhost. Opened over plain HTTP on a network
 * address (e.g. from a phone), the portal links to the server's HTTPS port when it has one.
 */
function insecureContextHint() {
  const { httpsPort } = session.config;
  if (httpsPort) {
    const url = `https://${location.hostname}:${httpsPort}${location.pathname}`;
    return `<span class="error">The browser only allows the camera over HTTPS.</span>
      <a href="${esc(url)}">Open the secure portal</a> <span class="muted">(the first time, your browser warns that the
      certificate is self-signed: choose to continue).</span> Or use a handheld scanner.`;
  }
  return `<span class="error">The browser only allows the camera over HTTPS or on localhost.</span>
    <span class="muted">Start the server with HTTPS_PORT set (e.g. HTTPS_PORT=3443) to scan from this device, or use a handheld scanner.</span>`;
}

/** Clears the last result and stops the camera (on sign-out). */
export function resetCheckin() {
  stopCamera();
  $('#checkin-result').innerHTML = '';
}

/** Explains up front when the camera cannot work on this address. Needs session.config. */
export function initCheckin() {
  if (!window.isSecureContext) $('#scanner-status').innerHTML = insecureContextHint();
}
