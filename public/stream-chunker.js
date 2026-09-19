/**
 * Turns the Web Speech API's growing "interim" transcript into small,
 * stable chunks that can be translated and shown while the speaker is
 * still talking, instead of waiting for the browser to mark the whole
 * phrase final (which only happens after a pause).
 *
 * Feed it every recognition result via update(); it calls onChunk(text,
 * segmentEnd) whenever it has a chunk ready. segmentEnd is true when the
 * chunk closes out the current phrase (the recognizer finalized it, or the
 * speaker went quiet), so listeners know when to start a new line.
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
  const DEFAULTS = { commitAt: 10, holdBack: 3, minChunk: 4, idleMs: 1500 };
  const LANG_DEFAULTS = { zh: { commitAt: 14, holdBack: 4, minChunk: 6 } };
  const BREAK_RE = /[.!?;:,،؛؟。！？；：，]$/;

  function tokenize(text, lang) {
    if (lang === 'zh') return Array.from(text.replace(/\s+/g, ''));
    return text.trim().split(/\s+/).filter(Boolean);
  }

  function join(tokens, lang) {
    return tokens.join(lang === 'zh' ? '' : ' ');
  }

  function createChunker(options) {
    const cfg = Object.assign({ lang: 'en' }, DEFAULTS, LANG_DEFAULTS[options.lang], options);
    let index = -1;       // which recognition result we're tracking
    let committed = 0;    // tokens of that result already sent
    let tokens = [];      // latest tokens of that result
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

    function reset() {
      clearIdle();
      index = -1; committed = 0; tokens = [];
    }

    return {
      update(resultIndex, text, isFinal) {
        if (resultIndex !== index) { index = resultIndex; committed = 0; }
        tokens = tokenize(text, cfg.lang);

        if (isFinal) {
          const rest = tokens.slice(committed);
          reset();
          emit(rest, true);
          return;
        }

        armIdle();
        if (tokens.length - committed < cfg.commitAt) return;

        // Everything but the unstable tail is committable; prefer to cut at
        // a clause/sentence boundary so chunks translate as whole thoughts.
        let cut = tokens.length - cfg.holdBack;
        for (let i = cut - 1; i >= committed + cfg.minChunk - 1; i--) {
          if (BREAK_RE.test(tokens[i])) { cut = i + 1; break; }
        }
        emit(tokens.slice(committed, cut), false);
        committed = cut;
      },

      // Recognizer stopped/restarted without finalizing: send what's left.
      flush() {
        if (index !== -1 && tokens.length > committed) emit(tokens.slice(committed), true);
        reset();
      },

      reset,
    };
  }

  return { createChunker };
});
