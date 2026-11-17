import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { DAY_MS } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockGateway } from '../src/services/payments.js';
import { ensureDevCertificate, loadTlsCredentials } from '../src/tls.js';

const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'parkslot-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** GET over HTTPS, trusting only `ca`, so the certificate must really match the host name. */
function get(url, ca) {
  return new Promise((resolve, reject) => {
    request(url, { ca }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

test('the development certificate covers localhost and network addresses, and is reused until it no longer fits', { skip: !hasOpenssl && 'openssl not installed' }, (t) => {
  const dir = tempDir(t);
  const first = ensureDevCertificate(dir, ['localhost', '127.0.0.1', '192.168.1.43']);
  assert.equal(first.generated, true);
  const cert = new X509Certificate(first.cert);
  assert.ok(cert.checkHost('localhost'));
  assert.ok(cert.checkIP('127.0.0.1'));
  assert.ok(cert.checkIP('192.168.1.43'));
  assert.equal(statSync(join(dir, 'key.pem')).mode & 0o777, 0o600);

  const again = ensureDevCertificate(dir, ['localhost', '192.168.1.43']);
  assert.equal(again.generated, false);
  assert.deepEqual(again.cert, first.cert);

  // A new network address, or a certificate close to expiry, gets a fresh certificate.
  assert.equal(ensureDevCertificate(dir, ['localhost', '10.0.0.7']).generated, true);
  assert.equal(ensureDevCertificate(dir, ['localhost', '10.0.0.7'], Date.now() + 820 * DAY_MS).generated, true);
});

test('the app is served over HTTPS with the generated certificate', { skip: !hasOpenssl && 'openssl not installed' }, async (t) => {
  const tls = loadTlsCredentials({ tlsDir: tempDir(t) }, ['localhost', '127.0.0.1']);
  const server = createServer({ cert: tls.cert, key: tls.key }, createApp({ db: openDb(':memory:'), gateway: createMockGateway() }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const res = await get(`https://127.0.0.1:${server.address().port}/api/config`, tls.cert);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).currency, 'INR');
  assert.equal((await get(`https://localhost:${server.address().port}/admin/`, tls.cert)).status, 200);
});

test('your own certificate files must come as a pair', () => {
  assert.throws(() => loadTlsCredentials({ tlsCertFile: '/some/cert.pem', tlsKeyFile: null }), /both TLS_CERT_FILE and TLS_KEY_FILE/);
});
