// HTTPS for local development. Browsers only allow the camera (the admin portal's QR scanner) in a secure
// context: http://localhost counts, but http://192.168.x.x does not, so a phone on the same network needs
// HTTPS. With no certificate of your own, a self-signed one is generated for localhost and this machine's
// network addresses. Browsers warn about it once; after continuing, the page is a secure context.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DAY_MS } from './config.js';

/** This machine's IPv4 addresses on its networks (not loopback), e.g. ['192.168.1.43']. */
export function networkAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function covers(certPem, hosts, now) {
  const cert = new X509Certificate(certPem);
  if (Date.parse(cert.validTo) - now < 30 * DAY_MS) return false; // renew well before expiry
  return hosts.every((host) => (isIP(host) ? cert.checkIP(host) : cert.checkHost(host)));
}

/**
 * A certificate and key valid for every name in `hosts`, from `dir`. A new self-signed pair is made with
 * openssl when there is none yet, or when the existing one lacks a host (e.g. the machine got a new IP
 * address) or expires within 30 days. Returns `{ cert, key, generated }`.
 */
export function ensureDevCertificate(dir, hosts, now = Date.now()) {
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  if (existsSync(certFile) && existsSync(keyFile) && covers(readFileSync(certFile), hosts, now)) {
    return { cert: readFileSync(certFile), key: readFileSync(keyFile), generated: false };
  }

  mkdirSync(dir, { recursive: true });
  const altNames = hosts.map((host) => (isIP(host) ? `IP:${host}` : `DNS:${host}`)).join(',');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-subj', '/CN=ParkSlot local development', '-addext', `subjectAltName=${altNames}`,
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'pipe' });
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'openssl is not installed' : String(err.stderr || err.message).trim();
    throw new Error(`Could not create a development certificate (${reason}). Install openssl, or set TLS_CERT_FILE and TLS_KEY_FILE.`);
  }
  chmodSync(keyFile, 0o600);
  return { cert: readFileSync(certFile), key: readFileSync(keyFile), generated: true };
}

/** The certificate to serve: your own files when configured, otherwise a generated development one. */
export function loadTlsCredentials(config, hosts) {
  if (config.tlsCertFile || config.tlsKeyFile) {
    if (!config.tlsCertFile || !config.tlsKeyFile) throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither.');
    return { cert: readFileSync(config.tlsCertFile), key: readFileSync(config.tlsKeyFile), generated: false };
  }
  return ensureDevCertificate(config.tlsDir, hosts);
}
