/**
 * Translation provider, isolated behind one function.
 * Callers just await translate(text, source, target, context); adding a
 * provider is a change to this file only.
 *
 * Which provider runs:
 *   1. An admin override set live from the admin dashboard (setOverride),
 *      held in memory, so a restart goes back to (2).
 *   2. Otherwise the env defaults, first configured wins: DeepL, then Azure
 *      Translator, then the free MyMemory API (fine for local dev, but its
 *      anonymous quota is small and shared across whatever IP the request
 *      comes from — not reliable once actually deployed).
 */

const ENV = {
  deeplKey: process.env.DEEPL_API_KEY || '',
  azureKey: process.env.AZURE_TRANSLATOR_KEY || '',
  azureRegion: process.env.AZURE_TRANSLATOR_REGION || '',
  mymemoryEmail: process.env.MYMEMORY_EMAIL || '',
};
const AZURE_ENDPOINT = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';
// Env only, never settable from the dashboard: lets the load test point DeepL
// at a local mock without the admin form becoming a "fetch any URL" tool.
const DEEPL_API_URL = process.env.DEEPL_API_URL || '';

// The caption path gives up after 6 s anyway (server.js); stop the request
// too, so a hung provider doesn't pile up open sockets behind it.
const REQUEST_TIMEOUT_MS = 6000;

// DeepL wants region-qualified codes for a couple of target languages our
// language list keeps generic; a Free-tier key always ends in ':fx' and
// must hit the separate free API host.
const DEEPL_TARGET_LANG_MAP = { en: 'EN-US', pt: 'PT-PT' };

async function translateDeepL(cfg, text, source, target, context) {
  const endpoint = DEEPL_API_URL || (cfg.deeplKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate');
  const params = {
    text,
    source_lang: source.toUpperCase(),
    target_lang: (DEEPL_TARGET_LANG_MAP[target] || target).toUpperCase(),
  };
  // Captions arrive a few words at a time, and a fragment translated on its
  // own comes out badly ("thank you for" -> the wrong "for"). `context` is
  // text DeepL reads to disambiguate but doesn't translate or bill for.
  if (context) params.context = context;
  const send = (p) => fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${cfg.deeplKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(p).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let res = await send(params);
  // Chunks arrive every couple of seconds, each translated into every
  // active language at once, so a busy moment can trip DeepL's rate limit.
  // Wait it out briefly rather than dropping the caption (the caller gives
  // up after a few seconds regardless, so later captions never pile up).
  for (let attempt = 1; (res.status === 429 || res.status === 503) && attempt <= 2; attempt++) {
    const retryAfter = parseFloat(res.headers.get('retry-after'));
    const waitMs = Math.min(isNaN(retryAfter) ? 400 * attempt : retryAfter * 1000, 1500);
    await new Promise(r => setTimeout(r, waitMs));
    res = await send(params);
  }
  if (res.status === 400 && params.context) {
    // If DeepL ever rejects the context for some language pair, a plain
    // translation beats no caption at all.
    delete params.context;
    res = await send(params);
  }
  if (res.status === 456) {
    // Monthly quota used up. Every retry would fail the same way, so say so
    // plainly: the fix is switching provider from the admin dashboard.
    const err = new Error('Translation quota used up (DeepL 456). Switch provider in the admin dashboard.');
    err.code = 'QUOTA_EXCEEDED';
    throw err;
  }
  if (!res.ok) throw new Error(`DeepL error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const translated = data?.translations?.[0]?.text;
  if (!translated) throw new Error('DeepL returned no translation');
  return translated;
}

// Azure uses script-qualified codes for a few languages our language list
// keeps generic (e.g. 'zh'); map only where they differ.
const AZURE_LANG_MAP = { zh: 'zh-Hans' };

async function translateAzure(cfg, text, source, target) {
  const from = AZURE_LANG_MAP[source] || source;
  const to = AZURE_LANG_MAP[target] || target;
  const url = `${AZURE_ENDPOINT}/translate?api-version=3.0&from=${from}&to=${to}`;
  const headers = { 'Ocp-Apim-Subscription-Key': cfg.azureKey, 'Content-Type': 'application/json' };
  if (cfg.azureRegion) headers['Ocp-Apim-Subscription-Region'] = cfg.azureRegion;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify([{ Text: text }]),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Azure Translator error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const translated = data?.[0]?.translations?.[0]?.text;
  if (!translated) throw new Error('Azure Translator returned no translation');
  return translated;
}

async function translateMyMemory(cfg, text, source, target) {
  const params = new URLSearchParams({ q: text, langpair: `${source}|${target}` });
  if (cfg.mymemoryEmail) params.set('de', cfg.mymemoryEmail);
  const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const data = await res.json();
  const translated = data?.responseData?.translatedText;
  // Quota and rate-limit problems come back in-band as a "successful" reply
  // whose translatedText is the warning itself — without this check that
  // warning gets fanned out to the audience as if it were a caption.
  if (data?.quotaFinished || Number(data?.responseStatus) >= 400 || /^MYMEMORY WARNING/i.test(translated || '')) {
    throw new Error(`MyMemory rejected the request (quota exhausted?): ${String(data?.responseDetails || translated || '').slice(0, 160)}`);
  }
  return translated || text;
}

const PROVIDERS = {
  deepl: { name: 'DeepL', run: translateDeepL },
  azure: { name: 'Azure Translator', run: translateAzure },
  mymemory: { name: 'MyMemory', run: translateMyMemory },
};

function envDefault() {
  if (ENV.deeplKey) return { provider: 'deepl', deeplKey: ENV.deeplKey };
  if (ENV.azureKey) return { provider: 'azure', azureKey: ENV.azureKey, azureRegion: ENV.azureRegion };
  return { provider: 'mymemory', mymemoryEmail: ENV.mymemoryEmail };
}

let override = null;

function activeConfig() {
  return override || envDefault();
}

// `context` is what the speaker said just before `text` (source language).
// Only DeepL supports it; other providers translate the text on its own.
// The provider is read per call, so a switch applies from the next chunk.
async function translate(text, source, target, context) {
  if (source === target) return text;
  const cfg = activeConfig();
  return PROVIDERS[cfg.provider].run(cfg, text, source, target, context);
}

// Printable ASCII only: keys go into HTTP headers, where a newline would be
// header injection and fetch would throw anyway.
const KEY_RE = /^[\x21-\x7e]{8,200}$/;
const REGION_RE = /^[a-z0-9]{2,30}$/;
const EMAIL_RE = /^[^\s@]{1,100}@[^\s@]{1,100}$/;

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function parseOverride(input) {
  const provider = String(input?.provider || '');
  if (!Object.hasOwn(PROVIDERS, provider)) throw invalid('Provider must be one of: deepl, azure, mymemory');
  if (provider === 'deepl') {
    const deeplKey = String(input.deeplKey || '').trim();
    if (!KEY_RE.test(deeplKey)) throw invalid('DeepL key must be 8-200 printable characters');
    return { provider, deeplKey };
  }
  if (provider === 'azure') {
    const azureKey = String(input.azureKey || '').trim();
    const azureRegion = String(input.azureRegion || '').trim().toLowerCase();
    if (!KEY_RE.test(azureKey)) throw invalid('Azure key must be 8-200 printable characters');
    if (azureRegion && !REGION_RE.test(azureRegion)) throw invalid('Azure region must look like "westeurope"');
    return { provider, azureKey, azureRegion };
  }
  const mymemoryEmail = String(input.mymemoryEmail || '').trim();
  if (mymemoryEmail && !EMAIL_RE.test(mymemoryEmail)) throw invalid('MyMemory email is not a valid address');
  return { provider, mymemoryEmail };
}

// Switches only after a test translation succeeds with the new settings, so
// a mistyped key can't silence captions mid-event.
async function setOverride(input) {
  const cfg = parseOverride(input);
  try {
    await PROVIDERS[cfg.provider].run(cfg, 'Hello', 'en', 'fr');
  } catch (err) {
    throw invalid(`Test translation failed, provider unchanged: ${String(err.message || err).slice(0, 300)}`);
  }
  override = cfg;
  return status();
}

function clearOverride() {
  override = null;
  return status();
}

function maskKey(key) {
  return key ? `…${key.slice(-4)}` : null;
}

function status() {
  const cfg = activeConfig();
  const key = cfg.deeplKey || cfg.azureKey || '';
  return {
    provider: cfg.provider,
    providerName: PROVIDERS[cfg.provider].name,
    source: override ? 'admin' : 'env',
    key: maskKey(key),
    region: cfg.azureRegion || null,
    warning: cfg.provider === 'mymemory'
      ? 'MyMemory is a free fallback with a small shared quota. Set a DeepL or Azure key for a live event.'
      : null,
  };
}

console.log(`[translate.js] Active translation provider: ${status().providerName}${status().warning ? ` (${status().warning})` : ''}`);

module.exports = { translate, setOverride, clearOverride, status };
