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

/**
 * What to tell staff when the camera does not start. `err` is what getUserMedia threw; `permission` is the
 * camera permission state afterwards ('granted' | 'denied' | 'prompt', or null where the browser can't say).
 */
export function cameraErrorMessage(err, permission = null) {
  switch (err?.name) {
    case 'NotAllowedError':
      if (/system/i.test(err.message)) {
        return 'Your computer is not letting the browser use the camera. Allow the browser in the system privacy settings (Camera), then try again.';
      }
      if (permission === 'denied') {
        return 'Camera access is blocked for this site. Click the camera or padlock icon in the address bar, allow the camera, then press "Scan with camera" again.';
      }
      return 'The camera was not allowed. Press "Scan with camera" again and choose Allow when the browser asks.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Connect one, or use a handheld scanner.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera could not be opened. It may be in use by another app or browser tab: close that and try again.';
    case 'SecurityError':
      return 'The browser does not allow the camera on this page. Open the portal over HTTPS or on localhost.';
    case 'AbortError':
      return 'The camera stopped while starting. Try again.';
    default:
      return err?.message || 'Could not start the camera.';
  }
}

async function cameraPermission() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state;
  } catch {
    return null; // not supported by this browser
  }
}

/**
 * Shows the camera in `video` and calls `onScan(text)` with the text of every QR code it reads
 * (repeatedly, while a code stays in view). Resolves to a function that stops the camera.
 */
export async function startScanner(video, onScan) {
  // Browsers only expose the camera in a secure context (https:// or http://localhost); the caller
  // checks window.isSecureContext first to offer an HTTPS link.
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera. Use a handheld scanner instead.');

  let stream;
  try {
    // Ask for the camera first, straight from the button click, then load the decoder.
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const decode = await createDecoder();
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
    throw new Error(cameraErrorMessage(err, err?.name === 'NotAllowedError' ? await cameraPermission() : null));
  }
}
