/**
 * Load client: plays N attendee phones per session plus one speaker console
 * per session, against a running server (local or deployed).
 *
 *   node loadtest/load.js --mode=steady --sessions=MAIN,MAIN-2 --audience=250 --langs=fr,es,de,ar,zh
 *
 * Modes
 *   steady  attendees connect, speakers talk for --duration s; latency, loss, order
 *   storm   steady, then every attendee socket is cut at once (venue Wi-Fi blip);
 *           time until all are back and how many logo bytes the reconnect cost
 *   burst   attendees arrive within --ramp ms doing what join.html does on page
 *           load (GET page + branding + logos, then the socket)
 *   switch  steady, and halfway through the admin API switches provider to Azure
 *
 * Captions carry "#<seq>" from the speaker's text, so each phone can measure
 * end-to-end latency and spot lost or out-of-order chunks. Latency includes
 * the translator's own time; "added" subtracts --mock-delay.
 *
 * --client=old|new mirrors join.html before/after the reconnect fix:
 *   old: reconnect after a fixed 1500 ms, logos fetched with ?t=Date.now()
 *   new: reconnect after 1500 + random(0..3000) ms, logos fetched with ?v=<logoVersion>
 *        and kept while the response allows caching (as a browser would)
 */

const fs = require('fs');
const WebSocket = require('ws');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : 'true'];
}));

const opt = {
  mode: args.mode || 'steady',
  base: (args.base || 'http://127.0.0.1:3100').replace(/\/$/, ''),
  sessions: (args.sessions || 'MAIN').split(','),
  audience: Number(args.audience || 100),
  langs: (args.langs || 'fr,es,de').split(','),
  src: args.src || 'en',
  duration: Number(args.duration || 60),
  interval: Number(args.interval || 2000),
  ramp: Number(args.ramp || 10000),
  client: args.client || 'old',
  mockDelay: Number(args['mock-delay'] || 300),
  adminEmail: args['admin-email'] || process.env.ADMIN_EMAIL || '',
  adminPassword: args['admin-password'] || process.env.ADMIN_PASSWORD || '',
  logoKb: Number(args['logo-kb'] || 0), // upload a generated PNG of this size to every session first
  out: args.out || '',
};
const wsBase = opt.base.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEQ_RE = /#(\d+)/;

let cookie = '';
let stopping = false;
const sentAt = new Map(); // `${session}#${seq}` -> ms
const clients = [];
const counters = { logoBytes: 0, logoRequests: 0, httpErrors: 0, rejected: 0, wsErrors: 0 };

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function login() {
  if (!opt.adminEmail) return;
  const res = await fetch(`${opt.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: opt.adminEmail, password: opt.adminPassword }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
}

async function uploadLogos() {
  if (!opt.logoKb) return;
  // PNG signature + filler: served by declared type, never decoded by the server.
  const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(opt.logoKb * 1024 - 8, 7)]);
  const type = 'image/png';
  for (const session of opt.sessions) {
    const form = new FormData();
    form.append('eventName', `Load test ${session}`);
    form.append('eventLogo', new Blob([data], { type }), 'logo.png');
    form.append('orgLogo', new Blob([data], { type }), 'logo.png');
    const res = await fetch(`${opt.base}/api/session/${session}/branding`, {
      method: 'POST', body: form, headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) throw new Error(`logo upload failed for ${session}: ${res.status} ${await res.text()}`);
  }
}

async function fetchLogos(c, b) {
  for (const kind of ['event', 'org']) {
    const has = kind === 'event' ? b.hasEventLogo : b.hasOrgLogo;
    if (!has) continue;
    const q = opt.client === 'new' && b.logoVersion ? `v=${b.logoVersion}` : `t=${Date.now()}`;
    const url = `/api/session/${c.session}/logo/${kind}?${q}`;
    if (c.cache.has(url)) continue;
    try {
      const res = await fetch(opt.base + url);
      const buf = Buffer.from(await res.arrayBuffer());
      counters.logoRequests++;
      counters.logoBytes += buf.length;
      if (/max-age=[1-9]/.test(res.headers.get('cache-control') || '')) c.cache.add(url);
    } catch { counters.httpErrors++; }
  }
}

function connectAudience(c) {
  const ws = new WebSocket(`${wsBase}/?role=audience&session=${c.session}&lang=${c.lang}`, { headers: { Origin: opt.base } });
  c.ws = ws;
  ws.on('open', () => { c.open = true; c.opens++; });
  ws.on('unexpected-response', (req, res) => { counters.rejected++; c.rejectedStatus = res.statusCode; });
  ws.on('error', () => { counters.wsErrors++; });
  ws.on('message', (data) => {
    c.bytes += data.length;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'joined') { c.joinedAt = Date.now(); if (msg.branding) fetchLogos(c, msg.branding); }
    if (msg.type === 'branding') fetchLogos(c, msg.branding);
    if (msg.type === 'caption') {
      const m = String(msg.text).match(SEQ_RE);
      if (!m) return;
      const seq = Number(m[1]);
      const t0 = sentAt.get(`${c.session}#${seq}`);
      if (t0) c.latencies.push(Date.now() - t0);
      if (seq <= c.lastSeq) c.outOfOrder++;
      c.lastSeq = Math.max(c.lastSeq, seq);
      c.seqs.add(seq);
      const provider = msg.text.split(':')[0];
      c.providers[provider] = (c.providers[provider] || 0) + 1;
    }
  });
  ws.on('close', () => {
    c.open = false;
    if (stopping || c.rejectedStatus) return;
    const delay = opt.client === 'new' ? 1500 + Math.random() * 3000 : 1500;
    setTimeout(() => connectAudience(c), delay);
  });
}

function makeClient(session, i) {
  return {
    session, lang: opt.langs[i % opt.langs.length], ws: null, open: false, opens: 0,
    bytes: 0, latencies: [], seqs: new Set(), lastSeq: 0, outOfOrder: 0,
    providers: {}, cache: new Set(), joinedAt: 0, pageStart: 0, rejectedStatus: 0,
  };
}

async function connectAll(withPageLoad) {
  const total = opt.sessions.length * opt.audience;
  const gap = opt.ramp / Math.max(1, total);
  const started = Date.now();
  for (let i = 0; i < opt.audience; i++) {
    for (const session of opt.sessions) {
      const c = makeClient(session, i);
      clients.push(c);
      if (withPageLoad) {
        c.pageStart = Date.now();
        (async () => {
          try {
            await (await fetch(`${opt.base}/join.html?session=${session}`)).arrayBuffer();
            const res = await fetch(`${opt.base}/api/session/${session}/branding`);
            if (res.ok) await fetchLogos(c, await res.json());
          } catch { counters.httpErrors++; }
          connectAudience(c);
        })();
      } else {
        connectAudience(c);
      }
      await sleep(gap);
    }
  }
  const deadline = Date.now() + opt.ramp + 30000;
  while (Date.now() < deadline && clients.some((c) => !c.open && !c.rejectedStatus)) await sleep(100);
  return Date.now() - started;
}

function startSpeakers() {
  const filler = 'we are measuring live caption delivery under load today';
  const speakers = opt.sessions.map((session) => {
    const ws = new WebSocket(`${wsBase}/?role=speaker&session=${session}`, {
      headers: { Origin: opt.base, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const s = { session, ws, seq: 0, rejected: 0 };
    ws.on('unexpected-response', (req, res) => { s.rejected = res.statusCode; });
    ws.on('error', () => {});
    return s;
  });
  return {
    speakers,
    ready: Promise.all(speakers.map((s) => new Promise((resolve) => {
      s.ws.on('open', resolve);
      s.ws.on('close', resolve);
    }))),
    send() {
      for (const s of speakers) {
        if (s.ws.readyState !== WebSocket.OPEN) continue;
        s.seq++;
        sentAt.set(`${s.session}#${s.seq}`, Date.now());
        s.ws.send(JSON.stringify({
          type: 'final_transcript', text: `#${s.seq} ${filler}`, srcLang: opt.src, segmentEnd: s.seq % 3 === 0,
        }));
      }
    },
  };
}

async function switchProvider() {
  const res = await fetch(`${opt.base}/api/admin/translator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ provider: 'azure', azureKey: 'mock-key-for-load-test', azureRegion: 'westeurope' }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function summarize(extra) {
  const lat = clients.flatMap((c) => c.latencies).sort((a, b) => a - b);
  const sent = Object.fromEntries(opt.sessions.map((s) => [s, 0]));
  for (const k of sentAt.keys()) sent[k.split('#')[0]]++;
  const expected = clients.reduce((n, c) => n + sent[c.session], 0);
  const received = clients.reduce((n, c) => n + c.seqs.size, 0);
  const providers = {};
  clients.forEach((c) => Object.entries(c.providers).forEach(([p, n]) => { providers[p] = (providers[p] || 0) + n; }));
  const minutes = Math.max(1 / 60, opt.duration / 60);
  const minus = (v) => (v == null ? null : v - opt.mockDelay);
  return {
    options: { ...opt, adminPassword: opt.adminPassword ? '***' : '' },
    attendees: clients.length,
    connected: clients.filter((c) => c.open).length,
    rejected: counters.rejected,
    chunksSent: sent,
    captionsExpected: expected,
    captionsReceived: received,
    deliveredPct: expected ? +((received / expected) * 100).toFixed(2) : null,
    outOfOrder: clients.reduce((n, c) => n + c.outOfOrder, 0),
    latencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.length ? lat[lat.length - 1] : null },
    addedLatencyMs: { p50: minus(pct(lat, 50)), p95: minus(pct(lat, 95)), p99: minus(pct(lat, 99)) },
    wsBytesPerAttendeePerMin: Math.round(clients.reduce((n, c) => n + c.bytes, 0) / clients.length / minutes),
    logoRequests: counters.logoRequests,
    logoMB: +(counters.logoBytes / 1048576).toFixed(2),
    httpErrors: counters.httpErrors,
    wsErrors: counters.wsErrors,
    providers,
    ...extra,
  };
}

async function main() {
  await login();
  await uploadLogos();
  const extra = {};
  // Presenters first: attendees can only join a session a presenter has opened.
  const talk = startSpeakers();
  await talk.ready;
  extra.speakerRejected = talk.speakers.filter((s) => s.rejected).map((s) => `${s.session}:${s.rejected}`);

  if (opt.mode === 'burst') {
    const t = Date.now();
    await connectAll(true);
    const joins = clients.filter((c) => c.joinedAt).map((c) => c.joinedAt - c.pageStart).sort((a, b) => a - b);
    extra.burst = { wallMs: Date.now() - t, joinMs: { p50: pct(joins, 50), p95: pct(joins, 95), max: joins.length ? joins[joins.length - 1] : null } };
    opt.duration = 0;
    talk.speakers.forEach((s) => s.ws.close());
  } else {
    extra.connectWallMs = await connectAll(false);
    await sleep(1000);
    const logoBefore = { bytes: counters.logoBytes, requests: counters.logoRequests };
    const ticks = Math.floor((opt.duration * 1000) / opt.interval);
    for (let i = 0; i < ticks; i++) {
      talk.send();
      if (opt.mode === 'switch' && i === Math.floor(ticks / 2)) extra.switch = await switchProvider();
      if (opt.mode === 'storm' && i === Math.floor(ticks / 3)) {
        const cutAt = Date.now();
        clients.forEach((c) => c.ws.terminate());
        (async () => {
          await sleep(100);
          while (clients.some((c) => !c.open)) await sleep(50);
          extra.storm = {
            recoverMs: Date.now() - cutAt,
            logoRequests: counters.logoRequests - logoBefore.requests,
            logoMB: +((counters.logoBytes - logoBefore.bytes) / 1048576).toFixed(2),
          };
        })();
      }
      await sleep(opt.interval);
    }
    await sleep(opt.mockDelay + 8000); // drain in-flight translations
    talk.speakers.forEach((s) => s.ws.close());
  }

  stopping = true;
  const result = summarize(extra);
  clients.forEach((c) => c.ws && c.ws.terminate());
  console.log(JSON.stringify(result, null, 2));
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(result, null, 2));
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => { console.error(err); process.exit(1); });
