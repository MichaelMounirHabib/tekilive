/**
 * Security regression checks against a running server. PASS = protected.
 *
 *   node loadtest/attack.js --base=http://127.0.0.1:3100 --session=MAIN \
 *     --admin-email=... --admin-password=...
 *
 * Admin credentials enable the checks that need a signed-in admin (SVG upload,
 * provider settings). The login rate-limit check runs last because it locks
 * this IP out of logging in for the limiter window.
 *
 * Exit code = number of failed checks.
 */

const net = require('net');
const WebSocket = require('ws');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : 'true'];
}));
const base = (args.base || 'http://127.0.0.1:3100').replace(/\/$/, '');
const wsBase = base.replace(/^http/, 'ws');
const session = args.session || 'MAIN';
const adminEmail = args['admin-email'] || process.env.ADMIN_EMAIL || '';
const adminPassword = args['admin-password'] || process.env.ADMIN_PASSWORD || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let cookie = '';

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

async function alive() {
  try { return (await fetch(`${base}/healthz`)).status === 200; } catch { return false; }
}

// Resolves with { opened, status, closeCode } once the socket opens and closes,
// or is refused at the handshake.
function tryWs(url, { headers = {}, onOpen } = {}) {
  return new Promise((resolve) => {
    const out = { opened: false, status: null, closeCode: null };
    const ws = new WebSocket(url, { headers: { Origin: base, ...headers } });
    const timer = setTimeout(() => { ws.terminate(); resolve(out); }, 3000);
    ws.on('open', () => { out.opened = true; if (onOpen) onOpen(ws); else ws.close(); });
    ws.on('unexpected-response', (req, res) => { out.status = res.statusCode; clearTimeout(timer); resolve(out); });
    ws.on('close', (code) => { out.closeCode = code; clearTimeout(timer); resolve(out); });
    ws.on('error', () => {});
  });
}

async function login() {
  if (!adminEmail) return false;
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return res.ok;
}

async function checkMalformedFrame() {
  await new Promise((resolve) => {
    const host = new URL(base);
    const s = net.connect(Number(host.port || 80), host.hostname, () => {
      s.write(`GET /?role=audience&session=${session}&lang=fr HTTP/1.1\r\nHost: ${host.host}\r\nOrigin: ${base}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      setTimeout(() => s.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0])), 300); // RSV1 set on an uncompressed connection
    });
    s.on('error', () => {});
    setTimeout(() => { s.destroy(); resolve(); }, 1200);
  });
  const ok = await alive();
  record('F1 malformed frame does not crash the server', ok, ok ? 'server alive' : 'server down');
  return ok;
}

async function checkNullMessage() {
  // Valid JSON that parses to null: a handler reading msg.type on it throws.
  await tryWs(`${wsBase}/?role=audience&session=${session}&lang=fr`, {
    onOpen: (ws) => { ws.send('null'); setTimeout(() => ws.close(), 300); },
  });
  await sleep(300);
  const ok = await alive();
  record('F14 a "null" message does not crash the server', ok, ok ? 'server alive' : 'server down');
  return ok;
}

async function checkBadHost() {
  // A Host header the URL parser rejects, on a WebSocket upgrade.
  await new Promise((resolve) => {
    const host = new URL(base);
    const s = net.connect(Number(host.port || 80), host.hostname, () => {
      s.write(`GET /?role=audience&session=${session}&lang=fr HTTP/1.1\r\nHost: a b\r\nOrigin: ${base}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('error', () => {});
    setTimeout(() => { s.destroy(); resolve(); }, 800);
  });
  const ok = await alive();
  record('F15 a malformed Host header does not crash the server', ok, ok ? 'server alive' : 'server down');
  return ok;
}

async function checkOversized() {
  const r = await tryWs(`${wsBase}/?role=audience&session=${session}&lang=fr`, {
    onOpen: (ws) => ws.send('x'.repeat(1024 * 1024)),
  });
  const ok = (await alive()) && r.closeCode === 1009;
  record('F5 1 MB message is refused', ok, `close code ${r.closeCode}`);
}

async function checkAnonBranding() {
  const form = new FormData();
  form.append('eventName', 'defaced');
  const res = await fetch(`${base}/api/session/${session}/branding`, { method: 'POST', body: form });
  record('F2 anonymous branding change is refused', res.status === 401 || res.status === 403, `HTTP ${res.status}`);
}

async function checkSvg() {
  const form = new FormData();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  form.append('eventLogo', new Blob([svg], { type: 'image/svg+xml' }), 'x.svg');
  const up = await fetch(`${base}/api/session/${session}/branding`, {
    method: 'POST', body: form, headers: cookie ? { Cookie: cookie } : {},
  });
  const logo = await fetch(`${base}/api/session/${session}/logo/event`);
  const servedSvg = logo.ok && /svg/.test(logo.headers.get('content-type') || '');
  record('F3 SVG logo is refused (even from an admin)', !servedSvg && up.status >= 400,
    `upload HTTP ${up.status}, logo served as ${logo.ok ? logo.headers.get('content-type') : logo.status}`);
}

async function checkSpeakerNoLogin() {
  const r = await tryWs(`${wsBase}/?role=speaker&session=${session}`);
  record('F4 speaker socket needs a login', !r.opened, r.opened ? 'opened' : `refused ${r.status}`);
}

async function checkBogusLang() {
  const r = await tryWs(`${wsBase}/?role=audience&session=${session}&lang=zz-made-up`);
  record('F6 unknown language is refused', !r.opened, r.opened ? 'opened' : `refused ${r.status}`);
}

async function checkUnknownSession() {
  const r = await tryWs(`${wsBase}/?role=audience&session=NOPE-${Date.now()}&lang=fr`);
  const res = await fetch(`${base}/api/session/NOPE-${Date.now()}/branding`);
  record('F7 unknown session code is refused', !r.opened && res.status === 404,
    `socket ${r.opened ? 'opened' : `refused ${r.status}`}, branding GET HTTP ${res.status}`);
}

async function checkTranslatorAnon() {
  const get = await fetch(`${base}/api/admin/translator`);
  const post = await fetch(`${base}/api/admin/translator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'deepl', deeplKey: 'anonymous-key-123' }),
  });
  const ok = [401, 403].includes(get.status) && [401, 403].includes(post.status);
  record('Provider settings need admin', ok, `GET ${get.status}, POST ${post.status}`);
}

async function checkTranslatorAdmin() {
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  const before = await (await fetch(`${base}/api/admin/translator`, { headers })).json().catch(() => null);
  const bad = await fetch(`${base}/api/admin/translator`, {
    method: 'POST', headers, body: JSON.stringify({ provider: 'deepl', deeplKey: 'bad-key-typo-0000' }),
  });
  const afterBad = await (await fetch(`${base}/api/admin/translator`, { headers })).json().catch(() => null);
  record('Bad provider key leaves provider unchanged', bad.status === 400 && JSON.stringify(before) === JSON.stringify(afterBad),
    `POST HTTP ${bad.status}, before=${before && before.provider}/${before && before.source}, after=${afterBad && afterBad.provider}/${afterBad && afterBad.source}`);

  const secret = 'good-key-abcdef-987654';
  const good = await fetch(`${base}/api/admin/translator`, {
    method: 'POST', headers, body: JSON.stringify({ provider: 'deepl', deeplKey: secret }),
  });
  const goodBody = await good.text();
  const status = await (await fetch(`${base}/api/admin/translator`, { headers })).text();
  const leaked = goodBody.includes(secret) || status.includes(secret);
  record('Provider key is never sent back to the browser', good.ok && !leaked, `POST HTTP ${good.status}, status=${status}`);
  await fetch(`${base}/api/admin/translator`, { method: 'DELETE', headers });
}

async function checkHeaders() {
  const res = await fetch(`${base}/`);
  const ok = !res.headers.get('x-powered-by') && res.headers.get('x-content-type-options') === 'nosniff';
  record('F10 security headers', ok, `x-powered-by=${res.headers.get('x-powered-by')}, nosniff=${res.headers.get('x-content-type-options')}`);
}

async function checkLoginRateLimit() {
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: `wrong-${i}` }),
    });
    last = res.status;
  }
  record('F9 repeated failed logins are throttled', last === 429, `11th attempt HTTP ${last}`);
}

async function main() {
  const signedIn = await login().catch(() => false);
  console.log(`admin login: ${signedIn ? 'ok' : 'not available'}\n`);
  for (const crashCheck of [checkMalformedFrame, checkNullMessage, checkBadHost]) {
    if (!(await crashCheck())) {
      console.log('\nServer is down; remaining checks skipped.');
      process.exit(results.filter((r) => !r.pass).length + 1);
    }
  }
  await checkOversized();
  await checkAnonBranding();
  await checkSvg();
  await checkSpeakerNoLogin();
  await checkBogusLang();
  await checkUnknownSession();
  await checkTranslatorAnon();
  if (signedIn) await checkTranslatorAdmin();
  else record('Provider settings (admin checks)', false, 'skipped: no admin login');
  await checkHeaders();
  await checkLoginRateLimit();
  await sleep(100);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed);
}

main().catch((err) => { console.error(err); process.exit(99); });
