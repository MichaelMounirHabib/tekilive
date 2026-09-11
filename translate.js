/**
 * Translation provider, isolated behind one function.
 * Swap in Azure Translator, DeepL, etc. by changing this file only —
 * callers just await translate(text, source, target).
 */

const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';

async function translate(text, source, target) {
  if (source === target) return text;
  const params = new URLSearchParams({ q: text, langpair: `${source}|${target}` });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json();
  return data?.responseData?.translatedText || text;
}

module.exports = { translate };
