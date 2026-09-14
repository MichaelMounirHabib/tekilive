const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { translate } = require('./translate');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

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
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const session = getSession(req.params.code.toUpperCase());
    if (typeof req.body.eventName === 'string') session.branding.eventName = req.body.eventName.slice(0, 120);
    if (typeof req.body.orgName === 'string') session.branding.orgName = req.body.orgName.slice(0, 120);
    const eventFile = req.files?.eventLogo?.[0];
    const orgFile = req.files?.orgLogo?.[0];
    if (eventFile) session.branding.eventLogo = { mime: eventFile.mimetype, data: eventFile.buffer };
    if (orgFile) session.branding.orgLogo = { mime: orgFile.mimetype, data: orgFile.buffer };
    const meta = brandingMeta(session);
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
    if (ALLOWED_ORIGINS.length === 0) return cb(true);
    cb(ALLOWED_ORIGINS.includes(info.origin));
  },
});

/**
 * In-memory session store.
 * sessions: Map<sessionCode, {
 *   speakers: Set<ws>,
 *   audience: Map<ws, { lang }>,
 *   branding: { eventName, orgName, eventLogo: {mime,data}|null, orgLogo: {mime,data}|null },
 * }>
 */
const sessions = new Map();

function getSession(code) {
  if (!sessions.has(code)) {
    sessions.set(code, {
      speakers: new Set(),
      audience: new Map(),
      branding: { eventName: '', orgName: '', eventLogo: null, orgLogo: null },
    });
  }
  return sessions.get(code);
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
    safeSend(ws, JSON.stringify({ type: 'joined', role: 'speaker', session: sessionCode, branding: brandingMeta(session) }));
    broadcastStats(session);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type !== 'final_transcript') return;

      const { text, srcLang } = msg;
      const start = Date.now();
      const langs = activeLanguages(session);
      if (langs.length === 0) return;

      await Promise.all(langs.map(async (lang) => {
        try {
          const translated = await translate(text, srcLang, lang);
          const latency = Date.now() - start;
          const payload = JSON.stringify({ type: 'caption', lang, text: translated, latency, ts: Date.now() });
          session.audience.forEach((meta, client) => { if (meta.lang === lang) safeSend(client, payload); });
          session.speakers.forEach(s => safeSend(s, JSON.stringify({ type: 'delivered', lang, text: translated, latency })));
        } catch (err) {
          session.speakers.forEach(s => safeSend(s, JSON.stringify({ type: 'error', lang, message: 'translation failed' })));
        }
      }));
    });

    ws.on('close', () => { session.speakers.delete(ws); pruneSessionIfEmpty(sessionCode, session); });
  } else {
    const lang = url.searchParams.get('lang') || 'en';
    session.audience.set(ws, { lang });
    safeSend(ws, JSON.stringify({ type: 'joined', role: 'audience', session: sessionCode, lang, branding: brandingMeta(session) }));
    broadcastStats(session);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'set_lang') {
        session.audience.set(ws, { lang: msg.lang });
        broadcastStats(session);
      }
    });

    ws.on('close', () => {
      session.audience.delete(ws);
      broadcastStats(session);
      pruneSessionIfEmpty(sessionCode, session);
    });
  }
});

server.listen(PORT, () => {
  console.log(`TekiLive server listening on port ${PORT}`);
});
