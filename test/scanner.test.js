import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraErrorMessage } from '../public/admin/scanner.js';

// getUserMedia rejects with DOMExceptions; only `name` and `message` matter here.
const error = (name, message = '') => ({ name, message });

test('a refused camera explains whether the site, the prompt, or the operating system said no', () => {
  assert.match(cameraErrorMessage(error('NotAllowedError'), 'denied'), /blocked for this site.*address bar/);
  assert.match(cameraErrorMessage(error('NotAllowedError'), 'prompt'), /choose Allow/);
  assert.match(cameraErrorMessage(error('NotAllowedError'), null), /choose Allow/);
  assert.match(cameraErrorMessage(error('NotAllowedError', 'Permission denied by system'), 'granted'), /system privacy settings/);
});

test('other camera failures each get their own advice', () => {
  assert.match(cameraErrorMessage(error('NotFoundError')), /No camera was found/);
  assert.match(cameraErrorMessage(error('OverconstrainedError')), /No camera was found/);
  assert.match(cameraErrorMessage(error('NotReadableError')), /in use by another app/);
  assert.match(cameraErrorMessage(error('SecurityError')), /HTTPS or on localhost/);
  assert.equal(cameraErrorMessage(new Error('Could not load the QR code reader.')), 'Could not load the QR code reader.');
  assert.equal(cameraErrorMessage(undefined), 'Could not start the camera.');
});
