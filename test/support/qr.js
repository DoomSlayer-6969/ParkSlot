import jsQR from 'jsqr';

/**
 * Reads back the text in a QR code SVG made by `qrSvg` (src/services/passes.js), the way a scanner
 * would: draws its rectangles onto a pixel grid and decodes that with jsQR, the decoder the admin
 * portal's camera scanner uses.
 */
export function decodeQrSvg(svg) {
  const [, size] = /viewBox="0 0 (\d+) \1"/.exec(svg).map(Number);
  const scale = 4;
  const width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y, w] of svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g).map((m) => m.map(Number))) {
    for (let py = y * scale; py < (y + 1) * scale; py++) {
      for (let px = x * scale; px < (x + w) * scale; px++) pixels.fill(0, (py * width + px) * 4, (py * width + px) * 4 + 3);
    }
  }
  return jsQR(pixels, width, width)?.data ?? null;
}
