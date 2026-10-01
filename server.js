if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const util = require('util');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const translator = require('./translate');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// The event's session codes (e.g. "MAIN,MAIN-2"). Anything else is refused,
// which also stops strangers creating sessions that sit in memory. Empty
// means any code is accepted, as before (local dev).
const SESSION_CODES = (process.env.SESSION_CODES || '')
  .split(',')
  .map(c => c.trim().toUpperCase())
  .filter(Boolean);
const DEFAULT_SESSION = SESSION_CODES[0] || 'MAIN';

// Only the path and query of a request are used. A constant base means a
// malformed Host header can't make this throw (it used to, inside the
// upgrade handler, which took the whole server down); a path the parser
// still rejects comes back as null and the request is refused.
function requestUrl(req) {
  try { return new URL(req.url, 'http://localhost'); } catch { return null; }
}

function sessionCodeFrom(raw) {
  const code = String(raw || DEFAULT_SESSION).trim().toUpperCase();
  return SESSION_CODES.length === 0 || SESSION_CODES.includes(code) ? code : null;
}

// Mirrors LANGUAGES in public/join.html and public/control.html; keep them in
// step. Anything else would be one more paid translation per caption.
const LANGUAGE_CODES = new Set(['en', 'ar', 'fr', 'es', 'de', 'zh', 'pt', 'ru', 'hi', 'tr']);

if (process.env.NODE_ENV === 'production') {
  const problems = auth.configProblems();
  if (!SESSION_CODES.length) problems.push('SESSION_CODES is required (e.g. MAIN,MAIN-2)');
  if (problems.length) {
    // Starting anyway would leave the presenter socket open to anyone.
    console.error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
}

const app = express();
// App Service (and most hosts) sit one proxy in front of the app; this makes
// req.ip the caller's address for the login limiter below.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Debug aid: lets the presenter console report what its speech engine and
// caption pipeline are doing, into the same log as the server's own lines,
// so a freeze can be traced end to end. Off unless CLIENT_LOG=1, since it
// records transcripts and accepts posts from anyone who can reach the server.
app.post('/api/client-log', (req, res) => {
  if (process.env.CLIENT_LOG !== '1') return res.status(404).end();
  const body = req.body || {};
  const tag = `[client ${String(body.session || '?').slice(0, 12)}]`;
  (Array.isArray(body.events) ? body.events.slice(0, 200) : []).forEach((e) => {
    log(tag, String(e && e.t || ''), String(e && e.kind || '').slice(0, 40), String(e && e.detail != null ? e.detail : '').slice(0, 400));
  });
  res.json({ ok: true });
});

// ponytail: in-memory per-IP counter, fine for one process and one event.
// Only failures count, and only logins: attendees never log in, so a venue
// full of phones behind one IP is never affected.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // ip -> { count, resetAt }

function loginBlocked(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { loginFailures.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now > entry.resetAt) loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else entry.count++;
  if (loginFailures.size > 10000) {
    loginFailures.forEach((e, key) => { if (now > e.resetAt) loginFailures.delete(key); });
  }
}

app.post('/api/auth/login', (req, res) => {
  if (!auth.isEnabled()) {
    return res.status(503).json({ error: 'Sign-in is not set up on this server. Set SESSION_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD where the server runs, then restart it.' });
  }
  if (loginBlocked(req.ip)) return res.status(429).json({ error: 'Too many failed sign-ins. Try again in 15 minutes.' });
  const body = req.body || {}; // Express 5 leaves it undefined for a non-JSON request
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!auth.checkAdminCredentials(email, password)) {
    noteLoginFailure(req.ip);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  loginFailures.delete(req.ip);
  res.set('Set-Cookie', auth.cookieHeader(auth.signToken()));
  res.json({ email: email.trim().toLowerCase(), role: 'admin' });
});

app.post('/api/auth/logout', (req, res) => {
  res.set('Set-Cookie', auth.clearCookieHeader());
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const authConfigured = auth.isEnabled();
  const user = auth.readUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in', authConfigured });
  res.json({ email: user.email, role: user.role, authConfigured });
});

app.get('/api/admin/sessions', auth.requireAdmin, (req, res) => {
  const list = Array.from(sessions.entries()).map(([code, session]) => ({
    code,
    speakerConnected: session.speakers.size > 0,
    speakerCount: session.speakers.size,
    audienceTotal: session.audience.size,
    audienceByLanguage: audienceStats(session),
    branding: brandingMeta(session),
  }));
  res.json(list);
});

// Translation provider, switchable live from the admin dashboard. The raw
// key is never sent back; status() masks it to its last 4 characters.
app.get('/api/admin/translator', auth.requireAdmin, (req, res) => {
  res.json(translator.status());
});

app.post('/api/admin/translator', auth.requireAdmin, async (req, res) => {
  try {
    const status = await translator.setOverride(req.body || {});
    log(`translation provider switched to ${status.providerName} (key ${status.key || 'none'}) by ${req.authUser.email}`);
    res.json(status);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to switch provider' });
  }
});

app.delete('/api/admin/translator', auth.requireAdmin, (req, res) => {
  const status = translator.clearOverride();
  log(`translation provider reset to env default ${status.providerName} by ${req.authUser.email}`);
  res.json(status);
});

// Event/organizer logos, uploaded per session. Stored in memory on the
// session object (like everything else here) rather than a cloud storage
// service — no new account/infra needed, and it matches the app's existing
// no-persistence lifecycle: branding lives as long as the session does.
// Raster formats only: an SVG can carry script that would run on this
// origin if someone opened the logo URL directly.
const LOGO_MAX_BYTES = 500 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 2, fields: 4, fieldSize: 1024 },
  fileFilter(req, file, cb) {
    if (LOGO_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Logo must be a PNG, JPEG or WebP image'));
  },
}).fields([{ name: 'eventLogo', maxCount: 1 }, { name: 'orgLogo', maxCount: 1 }]);

const NO_BRANDING = { eventName: '', orgName: '', hasEventLogo: false, hasOrgLogo: false, logoVersion: 0 };

function brandingMeta(session) {
  if (!session) return NO_BRANDING;
  return {
    eventName: session.branding.eventName,
    orgName: session.branding.orgName,
    hasEventLogo: !!session.branding.eventLogo,
    hasOrgLogo: !!session.branding.orgLogo,
    // Bumped on every logo upload; clients put it in the logo URL, so the
    // logo can be cached hard and a new upload still shows up at once.
    logoVersion: session.branding.logoVersion,
  };
}

app.get('/api/session/:code/branding', (req, res) => {
  const code = sessionCodeFrom(req.params.code);
  if (!code) return res.status(404).json({ error: 'Session not found' });
  res.json(brandingMeta(sessions.get(code)));
});

app.post('/api/session/:code/branding', auth.requireAdmin, (req, res) => {
  const code = sessionCodeFrom(req.params.code);
  if (!code) return res.status(404).json({ error: 'Session not found' });
  upload(req, res, (err) => {
    if (err) {
      log(`[${code}] branding upload rejected:`, err.message);
      return res.status(400).json({ error: err.message });
    }
    const session = getSession(code);
    const body = req.body || {}; // undefined in Express 5 when the request isn't multipart
    if (typeof body.eventName === 'string') session.branding.eventName = body.eventName.slice(0, 120);
    if (typeof body.orgName === 'string') session.branding.orgName = body.orgName.slice(0, 120);
    const eventFile = req.files?.eventLogo?.[0];
    const orgFile = req.files?.orgLogo?.[0];
    if (eventFile) session.branding.eventLogo = { mime: eventFile.mimetype, data: eventFile.buffer };
    if (orgFile) session.branding.orgLogo = { mime: orgFile.mimetype, data: orgFile.buffer };
    // A timestamp rather than a counter: after a restart a counter would start
    // again at 1, and phones that cached ?v=1 would keep showing the old logo.
    if (eventFile || orgFile) session.branding.logoVersion = Date.now();
    const meta = brandingMeta(session);
    log(`[${code}] branding updated:`, meta);
    const payload = JSON.stringify({ type: 'branding', branding: meta });
    session.speakers.forEach(s => safeSend(s, payload));
    session.audience.forEach((clientMeta, client) => safeSend(client, payload));
    res.json(meta);
  });
});

app.get('/api/session/:code/logo/:kind', (req, res) => {
  const code = sessionCodeFrom(req.params.code);
  const session = code && sessions.get(code);
  const logo = !session ? null : req.params.kind === 'org' ? session.branding.orgLogo : req.params.kind === 'event' ? session.branding.eventLogo : null;
  if (!logo) return res.status(404).end();
  res.set('Content-Type', logo.mime);
  res.set('Content-Security-Policy', "default-src 'none'");
  // Safe to cache: the URL carries ?v=<logoVersion>, which changes on upload.
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(logo.data);
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  // Captions are a few hundred bytes. The library default (100 MiB) would let
  // one client make the server buffer and parse a huge message.
  maxPayload: 16 * 1024,
  verifyClient(info, cb) {
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(info.origin)) return cb(false);

    const url = requestUrl(info.req);
    if (!url) return cb(false, 400, 'Bad request');
    const role = url.searchParams.get('role') || 'audience';
    if (!sessionCodeFrom(url.searchParams.get('session'))) return cb(false, 404, 'Session not found');

    if (role !== 'speaker') {
      // Audience join links stay open, no login needed.
      return LANGUAGE_CODES.has(url.searchParams.get('lang') || 'en') ? cb(true) : cb(false, 400, 'Unsupported language');
    }

    // Without a configured admin account nobody can sign in, so the
    // presenter socket is refused, same as the admin pages.
    return auth.readUserFromRequest(info.req) ? cb(true) : cb(false, 401, 'Sign in required');
  },
});
wss.on('error', (err) => log('WebSocket server error:', err.message));

/**
 * In-memory session store.
 * sessions: Map<sessionCode, {
 *   speakers: Set<ws>,
 *   audience: Map<ws, { lang }>,
 *   branding: { eventName, orgName, eventLogo: {mime,data}|null, orgLogo: {mime,data}|null, logoVersion },
 *   deliveryTails: Map<lang, Promise>, // keeps each language's captions in spoken order
 *   recentSource: { lang, text },      // tail of what the speaker just said, as translation context
 * }>
 */
const sessions = new Map();

function getSession(code) {
  if (!sessions.has(code)) {
    sessions.set(code, {
      speakers: new Set(),
      audience: new Map(),
      branding: { eventName: '', orgName: '', eventLogo: null, orgLogo: null, logoVersion: 0 },
      deliveryTails: new Map(),
      recentSource: { lang: null, text: '' },
    });
  }
  return sessions.get(code);
}

// Translating a few words in isolation goes badly, so each chunk is sent
// along with the last bit of what was said before it (never translated).
const CONTEXT_CHARS = 300;
function takeContext(session, srcLang, text) {
  const prev = session.recentSource;
  const context = prev.lang === srcLang ? prev.text : '';
  const joined = `${context} ${text}`.trim();
  // Keep the tail, starting on a word boundary rather than mid-word.
  const tail = joined.length > CONTEXT_CHARS ? joined.slice(-CONTEXT_CHARS).replace(/^\S*\s/, '') : joined;
  session.recentSource = { lang: srcLang, text: tail };
  return context;
}

// The translator tends to close every fragment with a full stop, even when
// the chunk stops mid-sentence. Drop it unless the speaker's own text ended
// a sentence there, otherwise "…new possibilities. for every event" appears.
const SENTENCE_END_RE = /[.!?…。！？؟]$/;
function tidyChunk(translated, sourceText, segmentEnd) {
  if (segmentEnd || SENTENCE_END_RE.test(sourceText)) return translated;
  return translated.replace(/[.。]\s*$/, '');
}

// Runs `deliver` once everything queued before it for this language has
// been delivered. `deliver` must handle its own errors, so one failure
// can't break the chain for every later caption.
function enqueueDelivery(session, lang, deliver) {
  const previous = session.deliveryTails.get(lang) || Promise.resolve();
  session.deliveryTails.set(lang, previous.then(deliver));
}

// A hung translation call would otherwise hold up every later caption in
// that language (they're delivered in order), so give up on it eventually.
const TRANSLATION_TIMEOUT_MS = 6000;
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`translation timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function activeLanguages(session) {
  const langs = new Set();
  session.audience.forEach(({ lang }) => langs.add(lang));
  return Array.from(langs);
}

function audienceStats(session) {
  const stats = {};
  session.audience.forEach(({ lang }) => { stats[lang] = (stats[lang] || 0) + 1; });
  return stats;
}

function broadcastStats(session) {
  const payload = JSON.stringify({ type: 'stats', totals: audienceStats(session), totalAudience: session.audience.size });
  session.speakers.forEach(ws => safeSend(ws, payload));
}

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(payload);
}

// Optional: also write the log to a file (LOG_FILE=tekilive-debug.log), so a
// problem seen on stage can be looked at afterwards without having been
// watching the terminal. Off by default.
const LOG_FILE = process.env.LOG_FILE ? path.resolve(__dirname, process.env.LOG_FILE) : null;
if (LOG_FILE) {
  try { if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0); } catch { /* no file yet */ }
}

function log(...args) {
  const stamp = `[${new Date().toISOString()}]`;
  console.log(stamp, ...args);
  if (LOG_FILE) fs.appendFile(LOG_FILE, `${stamp} ${util.format(...args)}
`, () => {});
}

function sessionHasBranding(session) {
  const b = session.branding;
  return !!(b.eventName || b.orgName || b.eventLogo || b.orgLogo);
}

// Once a presenter has set branding for a session code, treat it as
// configured for the event rather than transient — a presenter briefly
// reloading their console, or a lull with zero attendees connected,
// shouldn't silently wipe out logos/names they already uploaded.
function pruneSessionIfEmpty(code, session) {
  if (session.speakers.size === 0 && session.audience.size === 0 && !sessionHasBranding(session)) {
    sessions.delete(code);
  }
}

// Phones lock their screens and networks blip without the socket ever
// firing 'close' — ping every connection and terminate ones that stop
// answering, so dead clients don't linger in the audience/speaker sets
// and both ends detect the drop quickly enough to reconnect. A protocol-
// level ping/pong alone leaves a real gap: the client's readyState still
// reads OPEN until the server gives up on it (up to two full intervals),
// so a speaker's sentences can silently vanish into a half-dead socket
// for a stretch that feels exactly like random lag. Sending an app-level
// {type:'ping'} alongside it lets clients independently notice staleness
// and reconnect on their own, without waiting on the server's cleanup.
const HEARTBEAT_INTERVAL_MS = 12000;
function heartbeat() { this.isAlive = true; }
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
    safeSend(ws, '{"type":"ping"}');
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const url = requestUrl(req); // checked in verifyClient
  const role = url.searchParams.get('role') || 'audience';
  const sessionCode = sessionCodeFrom(url.searchParams.get('session')); // checked in verifyClient
  const session = getSession(sessionCode);

  // A malformed frame (bad opcode, oversized message, invalid UTF-8) makes
  // the socket emit 'error'. Without a listener Node treats that as an
  // uncaught exception and the whole server exits, dropping every attendee.
  // The library closes the offending socket itself; just record it.
  ws.on('error', (err) => log(`[${sessionCode}] ${role} socket error (${err.code || 'unknown'}): ${err.message}`));

  if (role === 'speaker') {
    session.speakers.add(ws);
    log(`[${sessionCode}] speaker connected (speakers=${session.speakers.size}, audience=${session.audience.size})`);
    safeSend(ws, JSON.stringify({ type: 'joined', role: 'speaker', session: sessionCode, branding: brandingMeta(session) }));
    broadcastStats(session);

    // The console sends the transcript in small chunks while the speaker is
    // still talking (see public/stream-chunker.js), not one message per
    // finished phrase. segmentEnd marks the chunk that closes a phrase.
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return; // "null" parses fine and would throw below
      if (msg.type !== 'final_transcript') return;

      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      const srcLang = msg.srcLang;
      if (!LANGUAGE_CODES.has(srcLang)) return;
      const segmentEnd = msg.segmentEnd !== false; // older consoles never send it: one phrase per message
      const start = Date.now();

      if (!text) {
        // Phrase ended with nothing new to translate — let audiences know
        // so their next caption starts a fresh line. Queued behind any
        // captions still being translated so it can't overtake them.
        if (segmentEnd) {
          const endPayload = JSON.stringify({ type: 'segment_end' });
          activeLanguages(session).forEach((lang) => enqueueDelivery(session, lang, () => {
            session.audience.forEach((meta, client) => { if (meta.lang === lang) safeSend(client, endPayload); });
          }));
        }
        return;
      }

      // Recorded for every chunk, even with nobody listening yet, so an
      // attendee joining mid-talk still gets context for what comes next.
      const context = takeContext(session, srcLang, text);

      const langs = activeLanguages(session);
      log(`[${sessionCode}] transcript chunk (${text.length} chars, srcLang=${srcLang}, segmentEnd=${segmentEnd}) — active target languages: [${langs.join(', ') || 'none'}], audience=${session.audience.size}`);
      if (langs.length === 0) {
        log(`[${sessionCode}] no audience listening in any language yet — nothing to translate`);
        return;
      }

      langs.forEach((lang) => {
        // Translate right away so chunks overlap in flight, but deliver each
        // language's chunks strictly in the order they were spoken — with
        // several chunks a second apart, a slow API call must not let a
        // later chunk overtake an earlier one on the audience's screen.
        const pending = withTimeout(translator.translate(text, srcLang, lang, context), TRANSLATION_TIMEOUT_MS);
        pending.catch(() => {}); // failure is reported at delivery time below
        enqueueDelivery(session, lang, async () => {
          try {
            const translated = tidyChunk(await pending, text, segmentEnd);
            const latency = Date.now() - start;
            log(`[${sessionCode}] translated ${srcLang}->${lang} in ${latency}ms: "${translated.slice(0, 60)}"`);
            const payload = JSON.stringify({ type: 'caption', lang, text: translated, segmentEnd, latency, ts: Date.now() });
            session.audience.forEach((meta, client) => { if (meta.lang === lang) safeSend(client, payload); });
            session.speakers.forEach(s => safeSend(s, JSON.stringify({ type: 'delivered', lang, text: translated, latency })));
          } catch (err) {
            log(`[${sessionCode}] TRANSLATION FAILED ${srcLang}->${lang}:`, err && err.stack ? err.stack : err);
            const message = err && err.code === 'QUOTA_EXCEEDED' ? 'translation quota used up' : 'translation failed';
            session.speakers.forEach(s => safeSend(s, JSON.stringify({ type: 'error', lang, message, detail: String(err && err.message || err).slice(0, 200) })));
          }
        });
      });
    });

    ws.on('close', () => {
      session.speakers.delete(ws);
      log(`[${sessionCode}] speaker disconnected (speakers=${session.speakers.size})`);
      pruneSessionIfEmpty(sessionCode, session);
    });
  } else {
    const lang = url.searchParams.get('lang') || 'en'; // checked in verifyClient
    session.audience.set(ws, { lang });
    log(`[${sessionCode}] audience joined (lang=${lang}, audience=${session.audience.size})`);
    safeSend(ws, JSON.stringify({ type: 'joined', role: 'audience', session: sessionCode, lang, branding: brandingMeta(session) }));
    broadcastStats(session);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return; // "null" parses fine and would throw below
      // Unchanged languages are ignored: each change recounts the audience
      // and messages the presenter, so a client spamming it costs CPU.
      if (msg.type === 'set_lang' && LANGUAGE_CODES.has(msg.lang) && session.audience.get(ws).lang !== msg.lang) {
        log(`[${sessionCode}] audience changed language to ${msg.lang}`);
        session.audience.set(ws, { lang: msg.lang });
        broadcastStats(session);
      }
    });

    ws.on('close', () => {
      session.audience.delete(ws);
      log(`[${sessionCode}] audience left (audience=${session.audience.size})`);
      broadcastStats(session);
      pruneSessionIfEmpty(sessionCode, session);
    });
  }
});

// ponytail: last-resort guard for a one-day event. Every known throw is fixed
// at its source; this keeps a missed one from dropping every attendee and the
// in-memory branding. It is logged loudly so it gets fixed, not ignored.
process.on('uncaughtException', (err) => {
  log('UNCAUGHT EXCEPTION (server kept running):', err && err.stack ? err.stack : err);
});

server.listen(PORT, () => {
  console.log(`TekiLive server listening on port ${PORT}`);
  if (!auth.isEnabled()) {
    log(`Sign-in is disabled: missing ${auth.missingSettings().join(', ')}. The presenter console and admin pages stay locked until these are set and the server is restarted.`);
  }
  const providerWarning = translator.status().warning;
  if (process.env.NODE_ENV === 'production' && providerWarning) log(`WARNING: ${providerWarning}`);
});
