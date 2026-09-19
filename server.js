if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const util = require('util');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { translate } = require('./translate');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const app = express();
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

app.post('/api/auth/login', async (req, res) => {
  if (!db.isEnabled() || !auth.isEnabled()) return res.status(503).json({ error: 'Accounts are not configured on this deployment' });
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await db.findUserByEmail(email);
  if (!user || !(await db.verifyPassword(user, password))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.set('Set-Cookie', auth.cookieHeader(auth.signToken(user)));
  res.json(db.toPublicUser(user));
});

app.post('/api/auth/logout', (req, res) => {
  res.set('Set-Cookie', auth.clearCookieHeader());
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const authConfigured = db.isEnabled() && auth.isEnabled();
  const user = auth.readUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in', authConfigured });
  res.json({ id: user.id, email: user.email, role: user.role, sessionCode: user.sessionCode, stageName: user.stageName, authConfigured });
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

app.get('/api/admin/users', auth.requireAdmin, async (req, res) => {
  res.json(await db.listUsers());
});

app.post('/api/admin/users', auth.requireAdmin, async (req, res) => {
  const { email, password, sessionCode, stageName } = req.body;
  const role = req.body.role === 'admin' ? 'admin' : 'stage_manager';
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (role === 'stage_manager' && !sessionCode) return res.status(400).json({ error: 'Session code is required for a stage manager account' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const existing = await db.findUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
  try {
    const user = await db.createUser({
      email, password, role,
      sessionCode: role === 'stage_manager' ? sessionCode : null,
      stageName: role === 'stage_manager' ? (stageName || null) : null,
    });
    res.status(201).json(db.toPublicUser(user));
  } catch (err) {
    log('Failed to create account:', err.message);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.delete('/api/admin/users/:id', auth.requireAdmin, async (req, res) => {
  const target = await db.findUserById(req.params.id);
  if (target && target.role === 'admin' && (await db.countAdmins()) <= 1) {
    return res.status(400).json({ error: 'Cannot remove the last remaining admin account' });
  }
  await db.deleteUser(req.params.id);
  res.json({ ok: true });
});

// Event/organizer logos, uploaded per session. Stored in memory on the
// session object (like everything else here) rather than a cloud storage
// service — no new account/infra needed, and it matches the app's existing
// no-persistence lifecycle: branding lives as long as the session does.
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES },
  fileFilter(req, file, cb) {
    cb(null, file.mimetype.startsWith('image/'));
  },
}).fields([{ name: 'eventLogo', maxCount: 1 }, { name: 'orgLogo', maxCount: 1 }]);

function brandingMeta(session) {
  return {
    eventName: session.branding.eventName,
    orgName: session.branding.orgName,
    hasEventLogo: !!session.branding.eventLogo,
    hasOrgLogo: !!session.branding.orgLogo,
  };
}

app.get('/api/session/:code/branding', (req, res) => {
  const session = getSession(req.params.code.toUpperCase());
  res.json(brandingMeta(session));
});

app.post('/api/session/:code/branding', (req, res) => {
  const code = req.params.code.toUpperCase();
  upload(req, res, (err) => {
    if (err) {
      log(`[${code}] branding upload rejected:`, err.message);
      return res.status(400).json({ error: err.message });
    }
    const session = getSession(code);
    if (typeof req.body.eventName === 'string') session.branding.eventName = req.body.eventName.slice(0, 120);
    if (typeof req.body.orgName === 'string') session.branding.orgName = req.body.orgName.slice(0, 120);
    const eventFile = req.files?.eventLogo?.[0];
    const orgFile = req.files?.orgLogo?.[0];
    if (eventFile) session.branding.eventLogo = { mime: eventFile.mimetype, data: eventFile.buffer };
    if (orgFile) session.branding.orgLogo = { mime: orgFile.mimetype, data: orgFile.buffer };
    const meta = brandingMeta(session);
    log(`[${code}] branding updated:`, meta);
    const payload = JSON.stringify({ type: 'branding', branding: meta });
    session.speakers.forEach(s => safeSend(s, payload));
    session.audience.forEach((clientMeta, client) => safeSend(client, payload));
    res.json(meta);
  });
});

app.get('/api/session/:code/logo/:kind', (req, res) => {
  const session = getSession(req.params.code.toUpperCase());
  const logo = req.params.kind === 'org' ? session.branding.orgLogo : req.params.kind === 'event' ? session.branding.eventLogo : null;
  if (!logo) return res.status(404).end();
  res.set('Content-Type', logo.mime);
  res.set('Cache-Control', 'no-store');
  res.send(logo.data);
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient(info, cb) {
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(info.origin)) return cb(false);

    const url = new URL(info.req.url, `http://${info.req.headers.host}`);
    const role = url.searchParams.get('role') || 'audience';
    if (role !== 'speaker') return cb(true); // audience join links stay open, no login needed

    // If accounts aren't configured on this deployment (no SESSION_SECRET
    // set), fall back to the original open-access behavior rather than
    // locking everyone out.
    if (!auth.isEnabled()) return cb(true);

    const sessionCode = (url.searchParams.get('session') || 'DEMO').toUpperCase();
    const user = auth.readUserFromRequest(info.req);
    if (!user) return cb(false, 401, 'Sign in required');
    if (user.role === 'admin') return cb(true);
    if (user.role === 'stage_manager' && user.sessionCode === sessionCode) return cb(true);
    return cb(false, 403, 'Not authorized for this session');
  },
});

/**
 * In-memory session store.
 * sessions: Map<sessionCode, {
 *   speakers: Set<ws>,
 *   audience: Map<ws, { lang }>,
 *   branding: { eventName, orgName, eventLogo: {mime,data}|null, orgLogo: {mime,data}|null },
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
      branding: { eventName: '', orgName: '', eventLogo: null, orgLogo: null },
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

  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'audience';
  const sessionCode = (url.searchParams.get('session') || 'DEMO').toUpperCase();
  const session = getSession(sessionCode);

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
      if (msg.type !== 'final_transcript') return;

      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      const srcLang = msg.srcLang;
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
        const pending = withTimeout(translate(text, srcLang, lang, context), TRANSLATION_TIMEOUT_MS);
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
            session.speakers.forEach(s => safeSend(s, JSON.stringify({ type: 'error', lang, message: 'translation failed', detail: String(err && err.message || err).slice(0, 200) })));
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
    const lang = url.searchParams.get('lang') || 'en';
    session.audience.set(ws, { lang });
    log(`[${sessionCode}] audience joined (lang=${lang}, audience=${session.audience.size})`);
    safeSend(ws, JSON.stringify({ type: 'joined', role: 'audience', session: sessionCode, lang, branding: brandingMeta(session) }));
    broadcastStats(session);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'set_lang') {
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

db.init()
  .then(() => log('Database ready'))
  .catch((err) => log('Database init failed (accounts/admin features will not work):', err.message));

server.listen(PORT, () => {
  console.log(`TekiLive server listening on port ${PORT}`);
});
