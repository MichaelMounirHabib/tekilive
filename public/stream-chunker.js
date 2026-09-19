/**
 * Turns the Web Speech API's growing "interim" transcript into small,
 * stable chunks that can be translated and shown while the speaker is
 * still talking, instead of waiting for the browser to mark the whole
 * phrase final (which only happens after a pause).
 *
 * Feed it the recognizer's full results list on every result event via
 * update(); it calls onChunk(text, segmentEnd) whenever it has a chunk
 * ready. segmentEnd is true when the chunk closes out the current phrase
 * (the recognizer finalized it, or it was flushed), so listeners know when
 * to start a new line.
 *
 * Chrome may report one stretch of speech as several not-yet-final results
 * at once (e.g. a steadier front part plus a still-changing tail), so the
 * chunker never tracks results one by one: everything since the last
 * finalized result is treated as a single running text.
 *
 * Loaded as a plain <script> in the presenter console; also require()-able
 * from Node for testing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StreamChunker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Tuning, in tokens (words; characters for Chinese, which Web Speech
  // returns without spaces). A chunk is sent once this many new tokens have
  // piled up, minus the last few — the recognizer keeps revising the tail
  // of what it just heard, so those are held back until they settle.
  //
  // Pace is the speed/quality trade-off: longer chunks give the translator
  // more to work with but appear later. Measured against translating the
  // whole text at once: fast ~82/100 at ~3s lag, balanced ~86 at ~5s,
  // quality ~89 at ~7s (lag = time to speak one chunk, at ~2.5 words/s).
  const PACES = {
    fast:     { commitAt: 10, holdBack: 3 },
    balanced: { commitAt: 16, holdBack: 3 },
    quality:  { commitAt: 24, holdBack: 4 },
  };
  const ZH_SCALE = 1.4; // a Chinese character carries less than a word does
  const DEFAULTS = { minChunk: 4, idleMs: 1500 };

  function settingsFor(options) {
    const lang = options.lang || 'en';
    const pace = PACES[options.pace] || PACES.fast;
    const scale = lang === 'zh' ? ZH_SCALE : 1;
    return Object.assign(
      { lang },
      DEFAULTS,
      { commitAt: Math.round(pace.commitAt * scale), holdBack: Math.round(pace.holdBack * scale) },
      lang === 'zh' ? { minChunk: 6 } : {},
      options // explicit values win, so tests can pin exact numbers
    );
  }
  const BREAK_RE = /[.!?;:,،؛؟。！？；：，]$/;

  // Words a chunk shouldn't end on ("thank you for | joining us"): cut there
  // and the translator gets a sentence with a missing piece and guesses
  // wrong. English only for now; other source languages just skip this.
  const DANGLING = {
    en: new Set(('a an the of to in on at for with by from about into over across through as than ' +
      'and but or so because if when while that which who whom whose how what why where ' +
      'is are was were be been am do does did can could will would should may might must not ' +
      // verbs that take "to": ending on "I want" leaves "to talk" for the
      // next chunk, and both sides then translate their own "to"
      'want wants wanted need needs going trying able thank thanks ' +
      'i we you he she it they my our your his her its their this these those there').split(' ')),
  };

  function dangles(token, lang) {
    const set = DANGLING[lang];
    return !!set && set.has(token.toLowerCase().replace(/[^a-z']/g, ''));
  }

  function tokenize(text, lang) {
    if (lang === 'zh') return Array.from(text.replace(/\s+/g, ''));
    return text.trim().split(/\s+/).filter(Boolean);
  }

  function join(tokens, lang) {
    return tokens.join(lang === 'zh' ? '' : ' ');
  }

  function createChunker(options) {
    const cfg = settingsFor(options);
    let base = 0;         // first result of the phrase still being spoken
    let committed = 0;    // tokens of that phrase's text already sent
    let tokens = [];      // latest tokens of that phrase's text
    let idleTimer = null;

    function emit(slice, segmentEnd) {
      const text = join(slice, cfg.lang);
      if (text || segmentEnd) cfg.onChunk(text, segmentEnd);
    }

    function clearIdle() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    function armIdle() {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        // Speaker paused mid-phrase and the recognizer hasn't finalized
        // yet: everything heard so far has settled, so send it now.
        if (tokens.length > committed) {
          emit(tokens.slice(committed), false);
          committed = tokens.length;
        }
      }, cfg.idleMs);
    }

    function textOf(results, from, to) {
      const parts = [];
      for (let i = from; i < to; i++) parts.push(results[i].text);
      return parts.join(' ');
    }

    function reset() {
      clearIdle();
      base = 0; committed = 0; tokens = [];
    }

    return {
      // results: the recognizer's whole list for the current run, as
      // [{ text, isFinal }, ...] in order.
      update(results) {
        if (base > results.length) reset(); // recognizer restarted: list started over

        // Leading finalized results close out the phrase: send whatever of
        // them hasn't gone out yet, marked as the end of the phrase.
        let end = base;
        while (end < results.length && results[end].isFinal) end++;
        if (end > base) {
          const finalTokens = tokenize(textOf(results, base, end), cfg.lang);
          const rest = finalTokens.slice(committed);
          // Chunks already sent may reach into the not-yet-final text after it.
          committed = Math.max(0, committed - finalTokens.length);
          base = end;
          emit(rest, true);
        }

        tokens = tokenize(textOf(results, base, results.length), cfg.lang);
        if (tokens.length === 0) { clearIdle(); return; }

        armIdle();
        if (tokens.length - committed < cfg.commitAt) return;

        // Everything but the unstable tail is committable; prefer to cut at
        // a clause/sentence boundary so chunks translate as whole thoughts.
        let cut = tokens.length - cfg.holdBack;
        let atBoundary = false;
        for (let i = cut - 1; i >= committed + cfg.minChunk - 1; i--) {
          if (BREAK_RE.test(tokens[i])) { cut = i + 1; atBoundary = true; break; }
        }
        // No punctuation to cut at: at least don't strand a linking word at
        // the end of the chunk — hand it to the next chunk instead. May back
        // off below minChunk here ("good morning everyone | and thank you…")
        // since a short whole phrase beats a long broken one.
        if (!atBoundary) {
          while (cut - committed > 2 && dangles(tokens[cut - 1], cfg.lang)) cut--;
        }
        emit(tokens.slice(committed, cut), false);
        committed = cut;
      },

      // Change the speed/quality trade-off while running. Done in place, not
      // by making a new chunker: the recognizer's results list carries on,
      // and a fresh chunker would resend every phrase already finished.
      setPace(pace) {
        const o = Object.assign({}, options, { pace });
        delete o.commitAt; delete o.holdBack; // explicit numbers would override the new pace
        const next = settingsFor(o);
        cfg.commitAt = next.commitAt;
        cfg.holdBack = next.holdBack;
      },

      // Recognizer stopped/restarted without finalizing: send what's left.
      flush() {
        if (tokens.length > committed) emit(tokens.slice(committed), true);
        reset();
      },

      reset,
    };
  }

  return { createChunker };
});
