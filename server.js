const express = require('express');
const http = require('http');
const path = require('path');
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
 * }>
 */
const sessions = new Map();

function getSession(code) {
  if (!sessions.has(code)) {
    sessions.set(code, { speakers: new Set(), audience: new Map() });
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

function pruneSessionIfEmpty(code, session) {
  if (session.speakers.size === 0 && session.audience.size === 0) sessions.delete(code);
}

// Phones lock their screens and networks blip without the socket ever
// firing 'close' — ping every connection and terminate ones that stop
// answering, so dead clients don't linger in the audience/speaker sets
// and both ends detect the drop quickly enough to reconnect.
const HEARTBEAT_INTERVAL_MS = 25000;
function heartbeat() { this.isAlive = true; }
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
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
    safeSend(ws, JSON.stringify({ type: 'joined', role: 'speaker', session: sessionCode }));
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
    safeSend(ws, JSON.stringify({ type: 'joined', role: 'audience', session: sessionCode, lang }));
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
