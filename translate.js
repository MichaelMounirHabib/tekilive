/**
 * Translation provider, isolated behind one function.
 * Swap providers by changing this file only — callers just await
 * translate(text, source, target).
 *
 * Picks the first configured provider: DeepL, then Azure Translator,
 * then falls back to the free MyMemory API (fine for local dev, but its
 * anonymous quota is small and shared across whatever IP the request
 * comes from — not reliable once actually deployed).
 */

const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
const AZURE_KEY = process.env.AZURE_TRANSLATOR_KEY || '';
const AZURE_REGION = process.env.AZURE_TRANSLATOR_REGION || '';
const AZURE_ENDPOINT = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';

// DeepL wants region-qualified codes for a couple of target languages our
// language list keeps generic; a Free-tier key always ends in ':fx' and
// must hit the separate free API host.
const DEEPL_TARGET_LANG_MAP = { en: 'EN-US', pt: 'PT-PT' };

async function translateDeepL(text, source, target) {
  const endpoint = DEEPL_API_KEY.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  const body = new URLSearchParams({
    text,
    source_lang: source.toUpperCase(),
    target_lang: (DEEPL_TARGET_LANG_MAP[target] || target).toUpperCase(),
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`DeepL error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const translated = data?.translations?.[0]?.text;
  if (!translated) throw new Error('DeepL returned no translation');
  return translated;
}

// Azure uses script-qualified codes for a few languages our language list
// keeps generic (e.g. 'zh'); map only where they differ.
const AZURE_LANG_MAP = { zh: 'zh-Hans' };

async function translateAzure(text, source, target) {
  const from = AZURE_LANG_MAP[source] || source;
  const to = AZURE_LANG_MAP[target] || target;
  const url = `${AZURE_ENDPOINT}/translate?api-version=3.0&from=${from}&to=${to}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_KEY,
      'Ocp-Apim-Subscription-Region': AZURE_REGION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ Text: text }]),
  });
  if (!res.ok) throw new Error(`Azure Translator error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const translated = data?.[0]?.translations?.[0]?.text;
  if (!translated) throw new Error('Azure Translator returned no translation');
  return translated;
}

async function translateMyMemory(text, source, target) {
  const params = new URLSearchParams({ q: text, langpair: `${source}|${target}` });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
  const res = await fetch(url);
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

async function translate(text, source, target) {
  if (source === target) return text;
  if (DEEPL_API_KEY) return translateDeepL(text, source, target);
  if (AZURE_KEY) return translateAzure(text, source, target);
  return translateMyMemory(text, source, target);
}

const activeProvider = DEEPL_API_KEY ? 'DeepL' : AZURE_KEY ? 'Azure Translator' : 'MyMemory (unreliable fallback — set DEEPL_API_KEY)';
console.log(`[translate.js] Active translation provider: ${activeProvider}`);

module.exports = { translate };
