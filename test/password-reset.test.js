import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINUTE_MS } from '../src/config.js';
import { openDb } from '../src/db.js';
import {
  confirmPasswordReset, createAccount, login, register, requestPasswordReset, userForToken,
} from '../src/services/auth.js';

const T0 = Date.UTC(2030, 0, 1, 10);
const OLD = 'old-password';
const NEW = 'new-password';

function setup() {
  const db = openDb(':memory:');
  const outbox = [];
  const mailer = { send: async (message) => { outbox.push(message); } };
  let now = T0;
  const session = register(db, { name: 'Alice', email: 'alice@test.dev', password: OLD }, T0);
  createAccount(db, { name: 'Admin', email: 'admin@test.dev', password: OLD, role: 'admin' }, T0);
  return {
    db,
    outbox,
    clock: () => now,
    advance: (ms) => { now += ms; },
    session,
    request: (email) => requestPasswordReset(db, mailer, { email }, now),
    confirm: (token, password = NEW) => confirmPasswordReset(db, { token, password }, now),
    tokenFrom: (message) => /#reset=([\w-]+)/.exec(message.text)[1],
  };
}

test('a reset link sets a new password, signs out other sessions, and works only once', () => {
  const ctx = setup();
  ctx.request('  ALICE@test.dev ');
  assert.equal(ctx.outbox.length, 1);
  const [mail] = ctx.outbox;
  assert.equal(mail.to, 'alice@test.dev');
  assert.match(mail.text, /^Hi Alice,/);
  assert.match(mail.text, /http:\/\/localhost:\d+\/#reset=[\w-]{43}/);
  const token = ctx.tokenFrom(mail);

  const result = ctx.confirm(token);
  assert.equal(result.user.email, 'alice@test.dev');
  assert.ok(userForToken(ctx.db, result.token, ctx.clock()), 'the new session works');
  assert.equal(userForToken(ctx.db, ctx.session.token, ctx.clock()), undefined, 'old sessions are signed out');

  assert.throws(() => login(ctx.db, { email: 'alice@test.dev', password: OLD }, ctx.clock()), { status: 401 });
  assert.equal(login(ctx.db, { email: 'alice@test.dev', password: NEW }, ctx.clock()).user.role, 'user');

  assert.throws(() => ctx.confirm(token, 'another-password'), { status: 400 }); // already used
});

test('only a hash of the reset token is stored', () => {
  const ctx = setup();
  ctx.request('alice@test.dev');
  const token = ctx.tokenFrom(ctx.outbox[0]);
  const rows = ctx.db.prepare('SELECT token_hash FROM password_resets').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test('unknown emails and admin accounts get no email', () => {
  const ctx = setup();
  ctx.request('nobody@test.dev');
  ctx.request('admin@test.dev');
  assert.equal(ctx.outbox.length, 0);
  assert.throws(() => ctx.request('not-an-email'), { status: 400 });
});

test('a reset link expires', () => {
  const ctx = setup();
  ctx.request('alice@test.dev');
  ctx.advance(30 * MINUTE_MS);
  assert.throws(() => ctx.confirm(ctx.tokenFrom(ctx.outbox[0])), { status: 400 });
  assert.equal(login(ctx.db, { email: 'alice@test.dev', password: OLD }, ctx.clock()).user.name, 'Alice');
});

test('repeat requests are throttled, and a newer link cancels older ones', () => {
  const ctx = setup();
  ctx.request('alice@test.dev');
  ctx.request('alice@test.dev'); // within the cooldown: no second email
  assert.equal(ctx.outbox.length, 1);

  ctx.advance(61_000);
  ctx.request('alice@test.dev');
  assert.equal(ctx.outbox.length, 2);
  const [first, second] = ctx.outbox.map(ctx.tokenFrom);
  assert.notEqual(first, second);
  assert.throws(() => ctx.confirm(first), { status: 400 });
  assert.equal(ctx.confirm(second).user.name, 'Alice');
});

test('a too-short password is rejected without using up the link', () => {
  const ctx = setup();
  ctx.request('alice@test.dev');
  const token = ctx.tokenFrom(ctx.outbox[0]);
  assert.throws(() => ctx.confirm(token, 'short'), { status: 400 });
  assert.equal(ctx.confirm(token).user.name, 'Alice');
});

test('made-up or missing tokens are rejected', () => {
  const ctx = setup();
  assert.throws(() => ctx.confirm('not-a-real-token'), { status: 400 });
  assert.throws(() => ctx.confirm(undefined), { status: 400 });
});

test('a failing mailer does not break the request', async () => {
  const db = openDb(':memory:');
  register(db, { name: 'Alice', email: 'alice@test.dev', password: OLD }, T0);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    requestPasswordReset(db, { send: async () => { throw new Error('SMTP down'); } }, { email: 'alice@test.dev' }, T0);
    requestPasswordReset(db, { send: () => { throw new Error('sync failure'); } }, { email: 'alice@test.dev' }, T0 + 61_000);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 2);
});
