/**
 * Stand-in for DeepL and Azure Translator during load tests, so a test run
 * never reaches a real (billed, rate-limited) provider.
 *
 *   DeepL:  POST /v2/translate                (form-encoded, like api.deepl.com)
 *   Azure:  POST /translate?api-version=3.0   (JSON, like the Translator v3 API)
 *   Stats:  GET  /stats                       (requests and characters per provider)
 *
 * The reply is the input prefixed with "<provider>:<target>:", so a test can
 * tell which provider produced a caption (used by the live-switch test).
 *
 * A key starting with "bad" is refused with 403, like a mistyped real key.
 *
 * Env: MOCK_PORT (3199), MOCK_DELAY_MS (300), MOCK_429_RATE (0..1, DeepL only).
 */

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 3199);
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 300);
const RATE_429 = Number(process.env.MOCK_429_RATE || 0);

const stats = { deepl: { requests: 0, chars: 0, throttled: 0 }, azure: { requests: 0, chars: 0 } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/stats') return reply(res, 200, stats);

  const raw = await readBody(req);
  await new Promise((r) => setTimeout(r, DELAY_MS));

  const key = String(req.headers['authorization'] || req.headers['ocp-apim-subscription-key'] || '').replace(/^DeepL-Auth-Key /, '');
  if (key.startsWith('bad')) return reply(res, 403, { message: 'Authorization failed' });

  if (req.method === 'POST' && url.pathname === '/v2/translate') {
    const form = new URLSearchParams(raw);
    const text = form.get('text') || '';
    const target = (form.get('target_lang') || '').toLowerCase();
    if (RATE_429 > 0 && Math.random() < RATE_429) {
      stats.deepl.throttled++;
      return reply(res, 429, { message: 'Too many requests' }, { 'Retry-After': '0.2' });
    }
    stats.deepl.requests++;
    stats.deepl.chars += text.length;
    return reply(res, 200, { translations: [{ detected_source_language: 'EN', text: `deepl:${target}:${text}` }] });
  }

  if (req.method === 'POST' && url.pathname === '/translate') {
    let items;
    try { items = JSON.parse(raw); } catch { return reply(res, 400, { error: 'bad json' }); }
    const to = url.searchParams.get('to') || '';
    const text = (items && items[0] && items[0].Text) || '';
    stats.azure.requests++;
    stats.azure.chars += text.length;
    return reply(res, 200, [{ translations: [{ text: `azure:${to}:${text}`, to }] }]);
  }

  reply(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock translator on ${PORT}, delay ${DELAY_MS}ms`));
