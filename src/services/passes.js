import { randomBytes } from 'node:crypto';
import { encode } from 'uqr';

// A check-in pass is the QR code a driver shows at the gate. It encodes PASS_PREFIX followed by the
// booking's check-in token: 128 random bits as uppercase hex. That keeps the whole payload inside the
// QR "alphanumeric" character set (a smaller, easier-to-scan code) and makes it case-insensitive, so a
// handheld scanner typing into a text box with Caps Lock on still works.
export const PASS_PREFIX = 'PARKSLOT:';
const TOKEN_PATTERN = /^[0-9A-F]{32}$/;

export function newPassToken() {
  return randomBytes(16).toString('hex').toUpperCase();
}

export function passPayload(token) {
  return PASS_PREFIX + token;
}

/** The check-in token in a scanned QR payload, or null if the text is not a ParkSlot pass. */
export function tokenFromPayload(text) {
  const value = String(text ?? '').trim().toUpperCase();
  if (!value.startsWith(PASS_PREFIX)) return null;
  const token = value.slice(PASS_PREFIX.length);
  return TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * The QR code for `text` as a standalone SVG: one module per SVG unit, with the standard 4-module
 * quiet zone. Each row's dark runs are drawn as one rectangle each, which keeps the file small.
 */
export function qrSvg(text) {
  const { data, size } = encode(text, { ecc: 'M', border: 4 });
  let path = '';
  data.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;
      let width = 1;
      while (x + width < size && row[x + width]) width++;
      path += `M${x} ${y}h${width}v1h-${width}z`;
      x += width - 1;
    }
  });
  // width/height let the browser rasterise it (e.g. onto a canvas to save it as a PNG).
  const px = size * 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
