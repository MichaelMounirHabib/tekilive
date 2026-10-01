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

// Only meaningful when the server has ALLOWED_ORIGINS set (the "after"
// profile sets it to the test's own base URL).
async function checkForeignOrigin() {
  const r = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/?role=audience&session=${session}&lang=fr`, { headers: { Origin: 'https://evil.example' } });
    const t = setTimeout(() => { ws.terminate(); resolve({ opened: false, status: 'timeout' }); }, 3000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve({ opened: true }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(t); resolve({ opened: false, status: res.statusCode }); });
    ws.on('error', () => {});
  });
  record('Socket from another website is refused (403)', !r.opened && r.status === 403, r.opened ? 'opened' : `refused ${r.status}`);
}

async function checkMalformedSessionCode() {
  const bad = ['BAD!CODE', 'A'.repeat(13), 'NEW%0ALINE'];
  const outcomes = [];
  for (const code of bad) {
    const r = await tryWs(`${wsBase}/?role=audience&session=${code}&lang=fr`);
    const res = await fetch(`${base}/api/session/${code}/branding`);
    outcomes.push({ code, ok: !r.opened && r.status === 400 && res.status === 400, detail: `${code}: socket ${r.opened ? 'opened' : r.status}, GET ${res.status}` });
  }
  record('F7 malformed session code is refused', outcomes.every((o) => o.ok), outcomes.map((o) => o.detail).join('; '));
}

async function checkAttendeeCannotOpenSession() {
  const code = 'NOTOPEN1';
  const r = await tryWs(`${wsBase}/?role=audience&session=${code}&lang=fr`);
  const res = await fetch(`${base}/api/session/${code}/branding`);
  record('Attendees cannot open a session', !r.opened && r.status === 404 && res.status === 404,
    `socket ${r.opened ? 'opened' : `refused ${r.status}`}, branding GET HTTP ${res.status}`);
}

// A presenter-page socket: no cookie, the key as a subprotocol.
function openWithPresenterKey(code, key) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/?role=speaker&session=${code}`, ['tekilive-presenter', key], { headers: { Origin: base } });
    const timer = setTimeout(() => resolve({ ws, opened: false, status: 'timeout' }), 3000);
    ws.on('open', () => { clearTimeout(timer); resolve({ ws, opened: true, protocol: ws.protocol }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(timer); resolve({ ws, opened: false, status: res.statusCode }); });
    ws.on('error', () => {});
  });
}

async function checkPresenterKeys() {
  const { list } = await adminSessions();
  const main = list.find((s) => s.code === session);
  const key = main && main.presenterKey;
  const wrong = await openWithPresenterKey(session, 'not-the-right-key-000');
  const right = key ? await openWithPresenterKey(session, key) : { opened: false, status: 'no key' };
  record('Presenter link: wrong key refused, right key opens', !wrong.opened && wrong.status === 401 && right.opened && right.protocol === 'tekilive-presenter',
    `wrong ${wrong.opened ? 'opened' : wrong.status}, right ${right.opened ? `opened (protocol echoed: ${right.protocol})` : right.status}`);
  if (right.ws) right.ws.close();
  if (wrong.ws) wrong.ws.close();

  // A key can't open a session: take one from a session, end it, try again.
  const opener = await openSpeaker('KEYTEST');
  const keyed = (await adminSessions()).list.find((s) => s.code === 'KEYTEST');
  await endSession('KEYTEST');
  opener.ws.close();
  await sleep(200);
  const reopen = keyed ? await openWithPresenterKey('KEYTEST', keyed.presenterKey) : { opened: false, status: 'no key' };
  record('Presenter link cannot open a closed session', !reopen.opened && reopen.status === 404, `after end: ${reopen.opened ? 'opened' : reopen.status}`);
  if (reopen.ws) reopen.ws.close();
  const anon = await fetch(`${base}/api/admin/sessions`);
  record('Presenter keys are admin-only', anon.status === 403, `anonymous session list HTTP ${anon.status}`);
}

async function checkSessionLimitSetting() {
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  const anonGet = await fetch(`${base}/api/admin/settings`);
  const anonPost = await fetch(`${base}/api/admin/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"maxSessions":99}' });
  record('Session limit setting needs admin', anonGet.status === 403 && anonPost.status === 403, `GET ${anonGet.status}, POST ${anonPost.status}`);

  const bad = [];
  for (const v of [0, 101, 2.5, 'x']) bad.push((await fetch(`${base}/api/admin/settings`, { method: 'POST', headers, body: JSON.stringify({ maxSessions: v }) })).status);
  record('Invalid session limits rejected', bad.every((s) => s === 400), `0/101/2.5/"x" -> ${bad.join(', ')}`);

  // Lower the limit to what is open now (the probe session): one more is refused.
  const openNow = (await adminSessions()).list.length;
  const set = await (await fetch(`${base}/api/admin/settings`, { method: 'POST', headers, body: JSON.stringify({ maxSessions: openNow }) })).json();
  const blocked = await openSpeaker('LIMITX');
  const reset = await (await fetch(`${base}/api/admin/settings`, { method: 'DELETE', headers })).json();
  const after = await openSpeaker('LIMITX');
  record('Lowering the limit blocks new sessions; reset restores it',
    set.maxSessions === openNow && !blocked.opened && blocked.status === 429 && after.opened,
    `limit ${set.maxSessions} with ${openNow} open: new ${blocked.opened ? 'opened' : blocked.status}; reset to ${reset.maxSessions}: new ${after.opened ? 'opened' : after.status}`);
  blocked.ws.close();
  after.ws.close();
  await sleep(200);
  await endSession('LIMITX');
}

// A presenter socket that stays open; resolves once it is open, refused, or
// after 3 s, so a dropped connection can never hang the run.
function openSpeaker(code) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/?role=speaker&session=${code}`, { headers: { Origin: base, Cookie: cookie } });
    const timer = setTimeout(() => resolve({ ws, opened: false, status: 'timeout' }), 3000);
    ws.on('open', () => { clearTimeout(timer); resolve({ ws, opened: true }); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(timer); resolve({ ws, opened: false, status: res.statusCode }); });
    ws.on('error', () => {});
  });
}

async function adminSessions() {
  const res = await fetch(`${base}/api/admin/sessions`, { headers: { Cookie: cookie } });
  return { list: await res.json(), limit: Number(res.headers.get('X-Session-Limit')) };
}

async function endSession(code) {
  return (await fetch(`${base}/api/admin/sessions/${code}`, { method: 'DELETE', headers: { Cookie: cookie } })).status;
}

async function checkSessionCapAndEnd() {
  const anonEnd = await fetch(`${base}/api/admin/sessions/MAIN`, { method: 'DELETE' });
  record('Ending a session needs admin', anonEnd.status === 403, `anonymous DELETE HTTP ${anonEnd.status}`);

  const { list, limit } = await adminSessions();
  const opened = [];
  for (let i = 1; list.length + opened.length < limit; i++) opened.push({ code: `CAP${i}`, ...(await openSpeaker(`CAP${i}`)) });
  const extra = await openSpeaker('CAPX');
  record(`Session cap (${limit}) refuses one more`, opened.every((o) => o.opened) && !extra.opened && extra.status === 429,
    `filled ${opened.length} slots, extra session ${extra.opened ? 'opened' : `refused ${extra.status}`}`);

  // An attendee on the first CAP session is told and disconnected when it ends.
  const target = opened[0];
  let ended = null, closed = null;
  if (target) {
    const ws = new WebSocket(`${wsBase}/?role=audience&session=${target.code}&lang=fr`, { headers: { Origin: base } });
    let gotEnded = false;
    ws.on('message', (d) => { if (String(d).includes('session_ended')) gotEnded = true; });
    ws.on('error', () => {});
    // Listen for the close before ending the session: the server can close
    // the socket before the DELETE response arrives.
    const closedP = new Promise((r) => {
      ws.on('close', (c) => r({ gotEnded, code: c }));
      setTimeout(() => r(null), 5000);
    });
    const opened = await new Promise((r) => { ws.on('open', () => r(true)); ws.on('unexpected-response', () => r(false)); setTimeout(() => r(false), 3000); });
    if (opened) { ended = { status: await endSession(target.code) }; closed = await closedP; }
  }
  const retry = await openSpeaker('CAPX');
  record('End session disconnects everyone and frees the slot',
    !!closed && ended.status === 200 && closed.gotEnded && retry.opened,
    closed ? `DELETE ${ended.status}, attendee got session_ended=${closed.gotEnded} close=${closed.code}, new session after: ${retry.opened ? 'opened' : retry.status}` : 'no CAP session to end');

  for (const o of opened) o.ws.close();
  extra.ws.close();
  retry.ws.close();
  await sleep(200);
  for (const code of ['CAPX', ...opened.map((o) => o.code)]) await endSession(code);
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
  // Attendees can only join an open session, so a presenter holds the probed
  // session open for the whole run (otherwise the frame checks below would be
  // refused at the handshake and prove nothing).
  const holder = signedIn ? await openSpeaker(session) : null;
  if (!holder || !holder.opened) console.log(`warning: could not open session ${session} as presenter; socket checks run against a refused handshake\n`);
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
  await checkMalformedSessionCode();
  await checkForeignOrigin();
  await checkAttendeeCannotOpenSession();
  if (signedIn) {
    await checkSessionCapAndEnd();
    await checkPresenterKeys();
    await checkSessionLimitSetting();
  } else record('Session cap, presenter links and limit (admin checks)', false, 'skipped: no admin login');
  await checkTranslatorAnon();
  if (signedIn) await checkTranslatorAdmin();
  else record('Provider settings (admin checks)', false, 'skipped: no admin login');
  if (holder && holder.ws) holder.ws.close();
  await checkHeaders();
  await checkLoginRateLimit();
  await sleep(100);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed);
}

main().catch((err) => { console.error(err); process.exit(99); });
