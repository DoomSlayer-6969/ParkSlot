// Drives the headless Firefox started by stack.sh over WebDriver BiDi (no Playwright/Selenium needed).
// Reads one command per line from stdin; see SKILL.md for the command list.
//   node .claude/skills/run-parkslot/driver.mjs <<'EOF'
//   nav /
//   screenshot home
//   EOF
// Exits 1 on the first failing command (after saving shots/error.png).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.PORT ?? 3123;
const BIDI_PORT = process.env.BIDI_PORT ?? 9333;
const RUN_DIR = process.env.PARKSLOT_RUN_DIR ?? join(process.env.TMPDIR || '/tmp', 'parkslot-run');
const SHOTS = join(RUN_DIR, 'shots');
const BASE = `http://localhost:${PORT}`;
const WAIT_MS = Number(process.env.WAIT_MS ?? 10_000);
mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- BiDi plumbing

const ws = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error(`cannot reach Firefox on port ${BIDI_PORT}: run stack.sh up first`));
});
let nextId = 0;
const pending = new Map();
ws.onclose = () => {
  // Firefox went away (e.g. stack.sh up/down ran meanwhile): fail anything still waiting.
  for (const { reject } of pending.values()) reject(new Error('Firefox closed the connection'));
  pending.clear();
};
const consoleLog = [];
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === 'error') reject(new Error(`${msg.error}: ${msg.message}`));
    else resolve(msg.result);
  } else if (msg.method === 'log.entryAdded') {
    consoleLog.push(`[${msg.params.level}] ${msg.params.text}`);
  }
};
// Every BiDi call gets a deadline, so a stuck browser fails the script instead of hanging it.
const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS ?? 30_000);
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method} got no answer from Firefox within ${SEND_TIMEOUT_MS} ms`));
  }, SEND_TIMEOUT_MS);
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v); },
    reject: (e) => { clearTimeout(timer); reject(e); },
  });
  ws.send(JSON.stringify({ id, method, params }));
});

// ACCEPT_INSECURE_CERTS=1 lets it open the server's self-signed HTTPS port (HTTPS_PORT in stack.sh).
await send('session.new', { capabilities: process.env.ACCEPT_INSECURE_CERTS === '1' ? { alwaysMatch: { acceptInsecureCerts: true } } : {} });
await send('session.subscribe', { events: ['log.entryAdded'] });
const context = (await send('browsingContext.getTree', {})).contexts[0].context;
await send('browsingContext.setViewport', { context, viewport: { width: 1280, height: 900 } });

async function js(expression) {
  const r = await send('script.evaluate', { target: { context }, expression, awaitPromise: true, resultOwnership: 'none' });
  if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
  return deserialize(r.result);
}
function deserialize(v) {
  if (!v) return undefined;
  if (v.type === 'array') return v.value.map(deserialize);
  if (v.type === 'object') return Object.fromEntries(v.value.map(([k, x]) => [typeof k === 'string' ? k : deserialize(k), deserialize(x)]));
  if (v.type === 'null' || v.type === 'undefined') return null;
  return v.value ?? v.type;
}
async function waitUntil(expression, what) {
  const end = Date.now() + WAIT_MS;
  for (;;) {
    try { if (await js(`Boolean(${expression})`)) return; } catch { /* page navigating */ }
    if (Date.now() > end) throw new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
// Numbering continues across driver runs, so a later run never overwrites an earlier run's screenshots.
let shotNo = readdirSync(SHOTS).filter((f) => f.endsWith('.png')).length;
async function screenshot(name = 'shot') {
  const { data } = await send('browsingContext.captureScreenshot', { context });
  const file = join(SHOTS, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

// ---------------------------------------------------------------- commands

const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const vars = {};
const visible = (selector) => `(${q(selector)}?.getClientRects().length > 0)`;

const COMMANDS = {
  // nav /admin/  — relative paths go to the app on $PORT
  async nav(arg) {
    await send('browsingContext.navigate', { context, url: new URL(arg, BASE).href, wait: 'complete' });
  },
  // wait-for <selector> — until it exists and is rendered (not inside a [hidden] view)
  'wait-for': (arg) => waitUntil(visible(arg), arg),
  // wait-js <expression> — until the expression is truthy
  'wait-js': (arg) => waitUntil(arg, arg),
  async click(arg) {
    await waitUntil(visible(arg), arg);
    await js(`(() => { const el = ${q(arg)}; el.scrollIntoView({ block: 'center' }); el.click(); })()`);
  },
  // fill <selector> <value> — the selector must not contain spaces; the value is the rest of the line
  async fill(arg) {
    const [selector, ...rest] = arg.split(' ');
    await waitUntil(`${q(selector)}`, selector);
    await js(`(() => { const el = ${q(selector)}; el.value = ${JSON.stringify(rest.join(' '))};
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  },
  // submit <form selector> — like pressing Enter in the form (runs its submit handler)
  submit: (arg) => js(`${q(arg)}.requestSubmit()`),
  text: async (arg) => { await waitUntil(q(arg), arg); console.log(await js(`${q(arg)}.innerText`)); },
  eval: async (arg) => console.log(JSON.stringify(await js(arg))),
  // set NAME <expression> — evaluate in the page and store the result as $NAME for later lines
  async set(arg) {
    const [name, ...rest] = arg.split(' ');
    vars[name] = await js(rest.join(' '));
    if (vars[name] == null) throw new Error(`${rest.join(' ')} gave nothing to store in $${name}`);
    console.log(`${name} = ${vars[name]}`);
  },
  // confirm-yes — answer OK to the next window.confirm() dialogs (headless cannot click them)
  'confirm-yes': () => js('window.confirm = () => true'),
  viewport: async (arg) => {
    const [width, height] = arg.split(/\s+/).map(Number);
    await send('browsingContext.setViewport', { context, viewport: { width, height } });
  },
  screenshot: async (arg) => console.log(await screenshot(arg || 'shot')),
  sleep: (arg) => new Promise((r) => setTimeout(r, Number(arg))),
  console: () => console.log(consoleLog.length ? consoleLog.join('\n') : '(no console output)'),
  // decode-qr <img selector> — reads a QR code shown on the page with the app's own jsQR, like the
  // admin scanner does, and stores the text as $QR for later commands (e.g. fill ... $QR)
  async 'decode-qr'(arg) {
    await waitUntil(`${q(arg)}?.complete && ${q(arg)}.naturalWidth > 0`, `${arg} to load`);
    vars.QR = await js(`(async () => {
      if (!window.jsQR) await new Promise((ok, fail) => {
        const s = document.createElement('script'); s.src = '/vendor/jsQR.js'; s.onload = ok; s.onerror = fail; document.head.append(s);
      });
      const img = ${q(arg)}; const c = document.createElement('canvas'); c.width = c.height = 600;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 600); ctx.drawImage(img, 0, 0, 600, 600);
      return jsQR(ctx.getImageData(0, 0, 600, 600).data, 600, 600)?.data ?? null;
    })()`);
    if (!vars.QR) throw new Error(`no QR code could be read from ${arg}`);
    console.log(`QR = ${vars.QR}`);
  },
};

// ---------------------------------------------------------------- script loop

const lines = readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
let failed = false;
for (const line of lines) {
  const [cmd, ...rest] = line.split(' ');
  const arg = rest.join(' ').replace(/\$(\w+)/g, (m, name) => vars[name] ?? m);
  const run = COMMANDS[cmd];
  try {
    if (!run) throw new Error(`unknown command "${cmd}" (known: ${Object.keys(COMMANDS).join(', ')})`);
    console.log(`> ${line}`);
    await run(arg);
  } catch (err) {
    console.error(`FAILED: ${line}\n  ${err.message}`);
    try { console.error(`  page at failure: ${await screenshot('error')}`); } catch { /* ignore */ }
    failed = true;
    break;
  }
}
const errors = consoleLog.filter((l) => l.startsWith('[error]'));
if (errors.length) console.log(`console errors:\n${errors.join('\n')}`);
await send('session.end').catch(() => {});
ws.close();
process.exit(failed ? 1 : 0);
