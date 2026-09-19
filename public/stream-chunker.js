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

  function norm(token) {
    return token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  // How many leading tokens of `next` and `sent` agree, allowing for the two
  // to have parted ways somewhere: scans back from the end for the last spot
  // where two words in a row still match.
  function agreedPrefix(next, sent) {
    const len = Math.min(next.length, sent.length);
    for (let i = len - 1; i >= 1; i--) {
      if (norm(next[i]) === norm(sent[i]) && norm(next[i - 1]) === norm(sent[i - 1])) return i + 1;
    }
    return 0;
  }

  // The recognizer keeps revising its guess, and sometimes throws it away
  // (say, it couldn't make out a word) and starts a different one in the
  // same slot. `committed` tokens have been sent, covering `sent`; given the
  // text as it reads now, how many of them does it still stand behind?
  // Counting blindly would skip the start of a replaced phrase, so compare
  // the tail of what was sent: if most of it changed, find where the two
  // parted ways and carry on from there. A word or two revised is normal
  // and changes nothing.
  function reconcile(next, sent, committed) {
    if (!committed) return 0;
    const len = Math.min(next.length, committed);
    const win = Math.min(4, len);
    if (win < 2) return committed; // too little text to judge yet
    let differ = 0;
    for (let i = len - win; i < len; i++) if (norm(next[i]) !== norm(sent[i])) differ++;
    return differ * 2 > win ? agreedPrefix(next, sent) : committed;
  }

  function createChunker(options) {
    const cfg = settingsFor(options);
    let base = 0;         // first result of the phrase still being spoken
    let committed = 0;    // tokens of that phrase's text already sent
    let tokens = [];      // latest tokens of that phrase's text
    let sent = [];        // the tokens those already-sent chunks covered
    let idleTimer = null;
    let lastKey = '';     // the text as of the last update, to tell real changes from repeats

    function realign() {
      const kept = reconcile(tokens, sent, committed);
      if (kept !== committed) { committed = kept; sent = sent.slice(0, kept); }
    }

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
        // yet: everything heard so far has settled, so send it now. If the
        // recognizer took back words we'd already sent and has held steady
        // since, this also carries on from where its text now stands.
        realign();
        if (tokens.length > committed) emit(tokens.slice(committed), false);
        committed = tokens.length;
        sent = tokens.slice();
      }, cfg.idleMs);
    }

    function textOf(results, from, to) {
      const parts = [];
      for (let i = from; i < to; i++) parts.push(results[i].text);
      return parts.join(' ');
    }

    function reset() {
      clearIdle();
      base = 0; committed = 0; tokens = []; sent = []; lastKey = '';
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
          // Where the final disagrees with what we sent, what we sent was a
          // guess the recognizer dropped — the final is the real text.
          const already = reconcile(finalTokens, sent, committed);
          const rest = finalTokens.slice(already);
          // Chunks already sent may reach into the not-yet-final text after it.
          committed = Math.max(0, already - finalTokens.length);
          sent = sent.slice(0, already).slice(finalTokens.length);
          base = end;
          emit(rest, true);
        }

        tokens = tokenize(textOf(results, base, results.length), cfg.lang);
        if (tokens.length === 0) { clearIdle(); return; }

        realign();

        // "The speaker paused" means the text stopped changing. A recognizer
        // that keeps re-sending the same words (noise, confidence updates)
        // must not keep pushing that timer back, or nothing is ever sent.
        const key = tokens.join(' ');
        if (key !== lastKey) { lastKey = key; armIdle(); }
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
        sent = tokens.slice(0, cut);
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

      // Read-only snapshot for diagnostics.
      state() { return { base, committed, tokens: tokens.length, idleArmed: !!idleTimer }; },

      reset,
    };
  }

  return { createChunker };
});
