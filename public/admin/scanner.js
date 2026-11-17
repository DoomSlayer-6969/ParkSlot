// Reads QR codes from the device camera. Uses the browser's built-in BarcodeDetector where it supports
// QR codes (Chrome on Android, macOS and ChromeOS) and falls back to jsQR, served by the app at /vendor.

const SCAN_INTERVAL_MS = 150;

let jsQrLoading = null;
function loadJsQr() {
  jsQrLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/jsQR.js';
    script.onload = () => resolve(window.jsQR);
    script.onerror = () => {
      jsQrLoading = null;
      script.remove();
      reject(new Error('Could not load the QR code reader. Check the connection and try again.'));
    };
    document.head.append(script);
  });
  return jsQrLoading;
}

/** Returns an async function that reads the QR code in the video's current frame, or null if there is none. */
async function createDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      if ((await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
      }
    } catch { /* fall back to jsQR */ }
  }

  const jsQR = await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    // Large frames are scaled down: decoding is much faster, and a pass held up to the camera is big.
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

function cameraError(err) {
  if (err.name === 'NotAllowedError') return 'Camera access was blocked. Allow it in the browser’s site settings, or use a handheld scanner.';
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (err.name === 'NotReadableError') return 'The camera is being used by another app.';
  return err.message || 'Could not start the camera.';
}

/**
 * Shows the camera in `video` and calls `onScan(text)` with the text of every QR code it reads
 * (repeatedly, while a code stays in view). Resolves to a function that stops the camera.
 */
export async function startScanner(video, onScan) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(window.isSecureContext
      ? 'This browser cannot use the camera. Use a handheld scanner instead.'
      : 'The camera only works when the portal is opened over HTTPS (or on localhost). Use a handheld scanner instead.');
  }

  let stream;
  try {
    const decode = await createDecoder();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();

    let stopped = false;
    let timer;
    const tick = async () => {
      if (stopped) return;
      if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth) {
        try {
          const text = await decode(video);
          if (text && !stopped) onScan(text);
        } catch { /* an unreadable frame; try the next one */ }
      }
      if (!stopped) timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };
    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    };
  } catch (err) {
    for (const track of stream?.getTracks() ?? []) track.stop();
    throw new Error(cameraError(err));
  }
}
