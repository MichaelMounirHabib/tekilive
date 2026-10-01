# TekiLive: one-time event hardening, 500+ attendees (Large)

Status: APPROVED. Phases 1-2 done; Phase 3 (final before/after run) in progress.

Target: one live event, two concurrent sessions, 300-500 attendees (load-tested locally to 1500).
Scope: code changes, finding fixes, local load testing. Azure deployment and any testing
on Azure are done by the owner, outside this plan.
Scope rule: smallest fix per gap, no new dependencies. "Optimal, not extreme."

## 0. Decisions

- [x] D1 Auth: remove Postgres. Env-only admin login (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`).
- [x] D3 Session codes: `SESSION_CODES=MAIN,MAIN-2` (typed as "Main" / "Main-2", uppercased by the app).
- [x] D3b MAIN and MAIN-2 run at the same time.
- [x] D2 Provider: DeepL for now. Must be switchable easily (see Phase 2, "Provider switch").
      Cost is out of scope for now. Capacity is not: see section 4.
- [x] D4 Harness committed under `loadtest\`.
- [x] D6 Provider set and switched live from the admin dashboard. Env settings stay as the
      defaults, unchanged from today's code.
- [x] D7 Languages: 3-5 target languages max.
- [ ] D7b Which languages? To guarantee the cap, the picker (`join.html` `LANGUAGES`) and the
      server allowlist (F6) are trimmed to them. Otherwise all 10 stay offered and any
      attendee can add one.

## 1. Findings (verified on this machine unless marked)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| F1 | Critical | One malformed WebSocket frame from any anonymous client crashes the process. All sessions and branding are lost and every attendee drops. `server.js` has no `ws.on('error')`. | Reproduced: 6-byte RSV1 frame -> `WS_ERR_UNEXPECTED_RSV_1`, `SERVER DIED` |
| F2 | High | `POST /api/session/:code/branding` has no auth. Anyone can replace the logo and event name on every phone. | Reproduced: anonymous upload -> 200 |
| F3 | High | Logo filter accepts `image/svg+xml`. It is served from the app origin with its `<script>` intact, so script runs on the same origin as the admin cookie. | Reproduced |
| F4 | High (config) | Speaker socket is open to anyone when `SESSION_SECRET` is unset (`server.js:182`). | Code |
| F5 | Medium | `ws` default `maxPayload` is 100 MiB (`ws/lib/websocket-server.js:74`). | Code |
| F6 | Medium | Audience `lang` is not validated. Each made-up language becomes an extra paid translation call per chunk. | Code |
| F7 | Medium | `getSession()` creates sessions from anonymous HTTP. Some are never pruned. | Code |
| F8 | Medium (perf) | Reconnect storm. Every phone retries at a fixed 1500 ms. Logos are refetched with a `Date.now()` cache-buster and `no-store` on page load, on `joined`, and on every reconnect. | `join.html:192,384,398` |
| F9 | Low | Login has no rate limit. | Code |
| F10 | Low | `jwt.verify` has no `algorithms` pin. `X-Powered-By` is sent. No `nosniff` / frame headers. | Code |
| F11 | Info | `render.yaml` pins Node 20 (EOL; App Service support retired 2026-04-30). | Research |
| F12 | Info | The console draws its QR through the third-party `api.qrserver.com` (`control.html:360`). If it is down or venue Wi-Fi blocks it, the on-screen QR is blank. Printing the two join links as QR codes ahead of time avoids it. No code change. | Code |
| F13 | High | `admin.html` put the attendee-supplied `lang` into `innerHTML` unescaped; with accounts on, an anonymous `lang=<img onerror=...>` ran script in the admin's session. Fixed by F6 (server allowlist) and escaping in `admin.html`. | Code |
| F14 | High | A WebSocket message of literal `null` crashed the server (`msg.type` on null). In the original code too. | Reproduced: `TypeError: Cannot read properties of null`, server exit 1 |
| F15 | High | A malformed `Host` header on a WebSocket upgrade crashed the server (`new URL` threw inside the upgrade handler). In the original code too. | Reproduced by the review agent: `TypeError: Invalid URL` |
| F16 | Env | This Windows laptop's loopback resets connections (both ends see `ECONNRESET`) and delays new ones by about 3 s once about 500-1000 sockets are open. Not the app: the heartbeat closed nothing and neither event loop stalled. Local numbers past ~500 sockets are not valid capacity figures. | Diagnosed with socket-level probes |

Constraints:
- Attendees likely share one venue public IP (NAT). No per-IP limit on the audience path.
- In-memory state, so exactly 1 instance.
- `npm audit`: 0 vulnerabilities.

## 2. Phase plan

### Phase 1: harness + baseline on current code (local)
- [x] `loadtest\mock-translator.js`: answers in DeepL's `/v2/translate` response shape
      (and Azure's, so either provider path can be tested), 300 ms delay, optional injected 429s.
      The server points at it with `DEEPL_API_URL` (added in Phase 2; the baseline run uses the
      Azure path through `AZURE_TRANSLATOR_ENDPOINT`, which already exists). No real provider is called.
- [x] `loadtest\probe.js` (`node -r`): records event-loop delay p50/p99, CPU %, RSS and heap every 5 s to a CSV.
- [x] `loadtest\load.js` (`ws`): N audience sockets over K languages. A speaker sends a ~50-char chunk every 2 s.
      It records added latency p50/p95/p99, delivered/expected ratio, bytes per attendee and connect failures.
- [x] `loadtest\attack.js`: one regression check per finding:
      - F1 malformed frame
      - F2 anonymous branding upload
      - F3 SVG upload
      - F5 1 MB message
      - F6 bogus `lang`
      - F7 unknown session code
      - F4 speaker connect without login
      - provider admin: anonymous GET/POST rejected, raw key never returned,
        bad key leaves the provider unchanged
- [x] Baseline scenarios:
      - B1: one session, N = 500 / 1000 / 1500, 9 languages
      - B1b: two sessions (`MAIN` + `MAIN-2`) speaking at the same time, 250+250 and 500+500,
        5 languages each (also one run at 9, to show margin)
      - After Phase 2 only: switch provider live from the admin API mid-run
        (mock A -> mock B) with 500 connected. Expect 0 lost or out-of-order captions.
      - B2: reconnect storm at 500
      - B3: join burst of 500 in 5 s with a 500 KB test logo
      - B4: `attack.js` (every check is expected to fail before the fixes)

### Phase 2: fixes
Remove Postgres (D1)
- [x] Delete `db.js`. `npm uninstall pg bcryptjs`.
- [x] `/api/auth/login`: compare against `ADMIN_EMAIL` / `ADMIN_PASSWORD` with
      `crypto.timingSafeEqual` on SHA-256 digests (stdlib).
      Sign the same JWT with role `admin`.
- [x] `auth.js` / `verifyClient`: only the admin role remains; the stage_manager branch goes.
- [x] Delete the `/api/admin/users` routes. In `admin.html`, remove the account-management
      section and keep the live sessions overview.
- [x] In production, refuse to start unless all of these hold:
      - `SESSION_SECRET` is at least 32 chars
      - `ADMIN_EMAIL` is set
      - `ADMIN_PASSWORD` is at least 12 chars
      This prevents an accidentally open speaker socket on the day.
- [x] `README.md` + `render.yaml`: drop the Postgres and accounts instructions. README lists every
      setting the app now needs in production (`NODE_ENV`, `SESSION_SECRET`, `ADMIN_EMAIL`,
      `ADMIN_PASSWORD`, `SESSION_CODES`, `ALLOWED_ORIGINS`, translator keys) for the deployment.
Provider switch (D2)
Two layers:
- Defaults: env settings, exactly as today (`DEEPL_API_KEY`, then `AZURE_TRANSLATOR_KEY` +
  region, then MyMemory with optional `MYMEMORY_EMAIL`; first key found wins).
- Admin override: set from the admin dashboard, live, no restart. It wins over the defaults
  while it is set. "Reset to defaults" goes back to env.

- [x] `translate.js`:
      - Provider functions take their key and region as arguments instead of reading
        module constants.
      - Add `getActiveConfig()`: returns the override if set, else the env defaults, resolved
        per call. Captions already in flight finish on the provider they started with.
      - Add `setOverride({ provider, deeplKey | azureKey + azureRegion | mymemoryEmail })`,
        `clearOverride()` and `status()`.
        - `status()` returns the provider, source (`admin` or `env`) and a masked key
          (last 4 chars only).
      - The call signature `translate(text, source, target, context)` is unchanged, so the
        caption path in `server.js` is untouched and adding a provider stays a one-file change.
      - Add `DEEPL_API_URL` env override (env only, never from the UI) for the load-test mock.
- [x] `server.js`, admin-only (`requireAdmin`):
      - `GET /api/admin/translator`: status, never the raw key.
      - `POST /api/admin/translator`:
        - Validates the provider against `deepl|azure|mymemory`, the key length (8-200),
          and the Azure region (`^[a-z0-9]{2,30}$`).
        - Runs a test translation ("Hello" en->fr) with the new settings before switching.
          If it fails, nothing changes and the provider's error is shown, so a typo'd key can't
          silence captions mid-event.
        - Logs the switch (provider and masked key only).
      - `DELETE /api/admin/translator`: back to env defaults.
- [x] `admin.html`: "Translation provider" card.
      - Shows the current provider, its source, the masked key and the last error.
      - A provider dropdown shows only the fields that provider needs (key, region, email).
      - Key fields are `type="password"` and cleared after saving.
      - Buttons: "Test & switch" and "Reset to defaults".
      - Rendered with `textContent`, not `innerHTML`.
- [x] Limits, by design:
      - The override lives in memory, so a restart reverts to env defaults. The primary event
        key belongs in the app settings; the dashboard is for switching on the day.
      - Endpoints can't be set from the UI (avoids turning the admin form into a
        server-side request tool).
      - One provider for both sessions (no per-session provider).
- [x] If the resolved default in production is MyMemory (no keys set), log a warning at
      startup and show it on the admin card. Its quota-warning check in `translate.js`
      already exists and stays.
- [x] DeepL 456 (quota exhausted) is surfaced to the presenter as "translation quota used up",
      and is not retried (a retry cannot succeed).
P0
- [x] F1: `ws.on('error')` plus `wss.on('error')`, logged.
- [x] F5: `maxPayload: 16 * 1024`.
P1
- [x] F2: branding POST requires the admin cookie (open only when auth is unconfigured, i.e. local dev).
- [x] F3: allowlist `image/png`, `image/jpeg`, `image/webp`. Logo response gets
      `nosniff` and `Content-Security-Policy: default-src 'none'`.
- [x] F7: `SESSION_CODES` allowlist.
      - Unknown code: WebSocket rejected, HTTP 404.
      - GET routes use `sessions.get` (no create).
      - Default code = first entry (`MAIN`) on the server. The `DEMO` fallbacks become `MAIN`
        (`control.html:123,358,382,444,490`, `join.html:170`). The presenter for `MAIN-2` types it in
        the console's session field.
      - `join.html` shows "Session not found, check the code" instead of looping on reconnect.
- [x] F6: audience `lang` must be one of the codes in `LANGUAGES`.
- [x] F8:
      - logo cap 500 KB
      - `logoVersion` in branding meta, clients use `?v=<version>`
      - `Cache-Control: public, max-age=86400`
      - `join.html` reconnect at 1500 ms + random 0-3000 ms
P2
- [x] F9: in-memory login limiter, 10 failures per IP per 15 min, `trust proxy 1`.
- [x] F10: `algorithms: ['HS256']`, `app.disable('x-powered-by')`, global `nosniff` + `X-Frame-Options: DENY`.

Added after the code review (all done):
- [x] F14: `if (!msg || typeof msg !== 'object') return` after both `JSON.parse` calls.
- [x] F15: `requestUrl()` parses against a constant base and returns null on a bad path.
- [x] `process.on('uncaughtException')` logs and keeps running (backstop only; the runner fails a run that logs one).
- [x] Production also requires `SESSION_CODES`. `logoVersion` is a timestamp (survives restarts).
  Branding body guard. `set_lang` with an unchanged language is ignored. `Object.hasOwn` for providers.
- [x] `render.yaml` Node 20 -> 22 (F11).
- [x] Not changed: the login limiter stays per IP. Venue NAT means someone on site could lock the
  presenters out for 15 min. The README says to sign in before doors open (12 h session) or use
  mobile data. A per-email key was rejected: anyone could then lock out the only admin.

### Phase 3: rerun locally, before/after table
- [x] Same B1-B4 scenarios plus the live provider-switch run. Results (this Windows laptop, Node 22,
      mock translator 300 ms; `loadtest/results/*-summary.json`):

      Caused by the fixes:

      | Scenario | Before | After |
      |---|---|---|
      | Security checks (`attack.js`) | server crashed at check 1 (F1) | 14/14 pass, 0 uncaught exceptions |
      | Reconnect storm, 500 phones: recovery / logo traffic | 8.6 s / 72 MB | 4.8 s / 0 MB |
      | Join burst, 500 in 5 s: join p95 / logo traffic | 8.1 s / 917 MB | 2.2 s / 488 MB |
      | Live provider switch, 500 connected | n/a | 100% delivered, 0 out of order (8000 DeepL, 7000 Azure) |

      Capacity (the fixes don't touch the caption path, so this is unchanged and applies to both):
      at 250+250 with 5 languages, 100% delivered, 0 out of order, event loop busy at most 11-12%
      of a 5 s window, RSS 73-76 MB. At 1500 attendees (after run): busy at most 21%, RSS 88 MB.

      Not claimed, environmental (F16): the 1000+ delivery gap (before 9.8-24%, after 99.9%; the
      laptop's network resets sockets in both versions and the baseline lost its test speaker to
      one), and the latency differences between runs (both carry resets and ~3 s SYN retries,
      server max up to 4 s). The 1500 busy figure for "before" (41.8%) includes that reconnect churn.
      Pass bar at 500: met on delivery, order, CPU, memory, security, storm recovery.
      Added latency (284 ms server p95 over the mock) misses the 250 ms target on this laptop;
      how much of that is the laptop's network needs a clean Linux run (open question). Proposed pass bar at 500 (targets, not measurements):
      - added latency p95 < 250 ms
      - event-loop p99 < 50 ms
      - 0 lost captions
      - reconnect storm 100% back within 10 s
      - RSS < 500 MB
      - all `attack.js` checks pass with the server alive

## 3. Translation volume (estimate, not measured against a real provider here)

Attendee count does not change volume. Cost scales with distinct languages
selected, because each chunk is translated once per language, not once per phone.
One curious attendee picking Hindi adds Hindi for the whole day, so at 300-500
attendees assume most offered languages will be active.

Inputs:
- Speaking rate: 145 wpm (lectures) typical, 169 wpm (TED talks) high (Chalmers / Open University study).
- 4.79 letters/word (Norvig, Google Books) + space/punctuation = 5.8 chars/word.
- +5% allowance for the chunker re-sending words after the recognizer discards a phrase (assumption).
- Billing counts every character, including spaces.
- Session hours: 5 typical, 6 high, for a one-day, one-room agenda (estimate from typical 8:30-16:30 agendas).
- Languages active: 3 / 5 / 9 targets. Of the 10 offered, the speaker's own language is free.
  Case studies show 3-12 languages at 500-900 attendees (Interprefy FemTech Lab: 4 at 500;
  Wordly Cohesity: 11 at 900, with about 1/3 of attendees using it).

Result: 53K chars per hour per language per speaking session (typical), 62K (high).

Two sessions speak at the same time (D3b) and each translates on its own, so the
totals double.

| Scenario | Target languages per session | Hours | Characters (2 sessions) | Peak chars/hour |
|---|---|---|---|---|
| Low | 3 | 5 | 1.59M | 318K |
| Typical | 5 | 5 | 2.65M | 530K |
| High (D7 cap) | 5 | 6, at 169 wpm | 3.71M | 618K |
| Uncapped (all 10 offered) | 9 | 6, at 169 wpm | 6.67M | 1.11M |

With 3-5 languages (D7), plan for 1.6M-3.7M characters. The last row only applies if the
picker keeps all 10 languages.

Request rate to DeepL (derived from `PACES` in `stream-chunker.js`, not measured):
- At 145 wpm (about 2.4 words/s), the default Balanced pace sends roughly one chunk every 5-6 s
  per session. Fast pace sends one every 3 s.
- At the D7 cap: 2 sessions x 5 languages = 10 requests per chunk cycle, about 2-3.5 requests/s
  (uncapped 9 languages: 18 per cycle, about 3-6/s).
- DeepL publishes no fixed rate limit. `translate.js` retries a 429 twice (capped at 1.5 s)
  and then drops that caption for that language. The real 429 rate is only visible against a real key.

DeepL capacity (a hard limit, separate from cost):
- DeepL API Free is 500K chars/month. Even the Low case (1.59M) is about 3x that.
  On a Free key, captions stop for every language once the quota hits (456), part-way
  through the morning in the Typical case.
- The event needs a paid DeepL plan with a quota above about 3.7M chars plus testing.
  Paid plan names and quotas are UNVERIFIED (DeepL's pages did not render; a search snippet
  says API Pro was replaced by a Growth plan).
- If the key is Free, the admin-dashboard switch (Phase 2) is the fallback: enter another
  provider's key and switch live when the presenter sees "translation quota used up".

Other notes:
- Quality: only DeepL receives `context` (and DeepL does not bill it), which is why it reads
  best on short fragments. Switching to Azure keeps captions flowing but rougher.
- Trimming `LANGUAGES` to what the audience needs is the lever on both volume and request rate.
- Arabic as the source language should come out lower (conversation rate 117.6 wpm
  including pauses). Arabic chars/word is UNVERIFIED, so the English figures are the upper bound.

## 4. Out of scope (deliberate)
- Azure deployment, Azure-side load tests, event-day checklist (owner)
- Redis or Web PubSub and multi-instance
- helmet / rate-limit packages
- CSP on HTML pages
- Front Door / WAF
- Unit test suite (`attack.js` covers the security fixes)
- DB TLS fix (the DB is removed)

---

# Whisper / server-side speech-to-text option (Large) — PLAN, waiting for approval

Whisper is speech-to-text, not translation. It fits as an alternative to the browser's
Web Speech engine (presenter side), not as a translation provider. Translation stays
DeepL/Azure/MyMemory.

## Research summary (sources in chat; model names and prices from vendor docs as read on 2026-10-01)
- OpenAI file transcription (`/v1/audio/transcriptions`): `gpt-transcribe` (recommended,
  $0.0045/min), `gpt-4o-transcribe` (~$0.006), `gpt-4o-mini-transcribe` (~$0.003),
  `whisper-1` (legacy, $0.006). 25 MB per file. Arabic: confirmed for whisper-1 only.
- OpenAI realtime transcription: `gpt-live-transcribe` ($0.017/min), PCM 24 kHz over
  WebSocket, delta + completed events, no server VAD. Lowest latency. Arabic UNVERIFIED.
- Azure OpenAI offers the same models (whisper, gpt-transcribe, gpt-live-transcribe) in the
  same Azure subscription; realtime in East US 2 / Sweden Central.
- Azure AI Speech: $1.00/h, continuous language ID (up to 10 languages, not within one sentence).
- Self-hosting Whisper on B1 (1 vCPU, no GPU): not viable (~1.5 GB RAM, about real time per stream).
- Cost for 2 sessions x 6 h: gpt-transcribe $3.24, whisper-1 $4.32, gpt-live-transcribe $12.24,
  Azure Speech $12.00.

## Decisions needed
- [ ] W1 Engine:
      - A (recommended): chunked transcription over HTTP with `gpt-transcribe`; `whisper-1` is selectable.
      - B: realtime `gpt-live-transcribe` proxied over WebSocket.
- [ ] W2 Account: OpenAI directly, or Azure OpenAI (same Azure subscription, data stays in Azure).
- [ ] W3 Default engine on event day: browser (recommended until Arabic/English quality is
      tested with your speakers) or Whisper.

## Plan (option A, about 500-700 lines + tests)
- [ ] `stt.js` (new, mirrors `translate.js`):
      - provider config from env (`STT_API_KEY`, `STT_MODEL`, endpoint env-only)
      - admin override with a test call, masked status
      - OpenAI and Azure OpenAI endpoints (same request shape)
- [ ] `server.js`:
      - extract the caption path into `handleTranscript()` (unchanged behavior)
      - add `POST /api/stt/:code`:
        - admin-only, Origin check, WAV only (RIFF magic)
        - limits: 10 s max per clip, 400 KB max, 1 request in flight per session, about 1/s
        - daily audio-minute cap
        - per-session queue keeps clips in spoken order
        - `segmentEnd` set from how the clip ended (silence vs max length)
      - add `/api/admin/stt` GET/POST/DELETE (global setting, same pattern as the translator)
      - broadcast the engine to presenter consoles
- [ ] `public/audio-capture.js` (new):
      - AudioWorklet mic capture to 16 kHz mono PCM, wrapped as WAV
      - silence gate: silent clips are never sent (cost, and Whisper invents text on silence)
      - clips cut at about 0.7 s of silence or at the pace's max length (4/6/9 s)
- [ ] `control.html`:
      - engine indicator; browser or Whisper path
      - after 2 consecutive failures, fall back to the browser engine automatically, with a warning
- [ ] `admin.html`: "Speech recognition" card (engine, model, key, test & switch, reset).
- [ ] `loadtest/`:
      - `mock-stt.js`
      - `attack.js` checks:
        - anonymous POST refused
        - oversize, non-WAV, too-long clip, unknown session/language refused
        - rate limit returns 429
        - cap enforced
        - a binary frame on the WebSocket doesn't crash the server
        - admin endpoints don't leak the key
      - `load.js`:
        - 2 sessions transcribing at once
        - clips out of order still give in-order captions
        - STT outage falls back to the browser engine
- [ ] README: setup, cost, privacy note (audio goes to OpenAI/Azure instead of Google's Web Speech).

## Risks
- Latency: clip length plus upload and transcription (about 1-2 s, estimate) means captions
  are about 5-10 s behind, versus 3-7 s today. Option B would be about 1-2 s, but is about
  800 lines and riskier before the event.
- Arabic quality on the new models is unverified; it needs a test with real speakers.
- New moving parts days before the event. The browser engine stays the default and the fallback.

---

# Session model: any code, presenter-opened, capped (done)

Replaces the `SESSION_CODES` allowlist (D3), at the owner's request.
- [x] Any code matching `^[A-Z0-9-]{1,12}$`; malformed codes get 400 (WebSocket and HTTP).
- [x] Only a signed-in presenter opens a session (console connect or branding save).
      `MAX_SESSIONS` (default 5) caps open sessions; the next one gets 429.
- [x] Attendees join open sessions only (404 otherwise). The join page shows
      "Not started yet" and checks again every 4-7 s until the session opens.
- [x] Admin "End session": sends `session_ended`, closes every socket, frees the slot.
      Consoles and phones stop reconnecting to an ended session.
- [x] Cleanup only deletes the session object it was called for, so a socket from an
      ended session can't delete a newer session opened under the same code.
- [x] Console says when every slot is in use and keeps retrying.
- [x] Production no longer requires `SESSION_CODES`.
- [x] Verified:
      - `attack.js` 18/18, three runs in a row, 0 uncaught exceptions. New checks:
        malformed codes, attendees can't open a session, the cap refuses a 6th,
        End session disconnects everyone and frees the slot, End session needs admin.
      - WSL with 250+250: 100% delivered, 0 rejected, storm recovery 4.5 s,
        live provider switch clean.

---

# Presenter page + adjustable session limit (Medium) — done

- [x] Session limit: in-memory admin override via `/api/admin/settings` (GET/POST/DELETE);
      env `MAX_SESSIONS` stays the default; 1-100; lowering never closes open sessions.
- [x] Presenter key per session: HMAC-SHA256(SESSION_SECRET, "presenter:" + code), 22 chars,
      stable across restarts. Revoke: new code, or rotate SESSION_SECRET.
- [x] Speaker socket accepts the admin cookie OR the presenter key. The key is sent as a
      WebSocket subprotocol (`tekilive-presenter`, key), never in a URL the server sees.
      A key only works for a session that is already open: it can't create, brand or end.
- [x] `/present.html`: the console in presenter mode (same code as control.html).
      - key in `#key=` (never sent to the server), no-referrer
      - no sign-in, no branding upload, no session field; attendee QR and join link stay (owner request)
      - waits and retries while the session isn't open
- [x] Presenter link shown in control.html (admin) and admin.html (per session, copy button).
- [x] admin.html: session-limit field (save / reset to default).
- [x] attack.js:
      - wrong key refused
      - right key opens an open session
      - right key can't open a closed session
      - limit setting is admin-only and validated
      - lowering the limit blocks new sessions
- [x] README.

- [x] Verified: attack.js 24/24 twice (0 uncaught); browser: admin console shows the presenter link, presenter page connects with the key and no sign-in, admin page shows the limit control and copy/end buttons.

---

# Control console buttons + silent origin refusal (done)

- [x] Bug: presenter page said "waiting for the admin" for an open session. Cause: the
      server's ALLOWED_ORIGINS (set in the owner's .env) excluded http://localhost:3000,
      so every WebSocket (control, presenter, attendees) was refused with a bare 401
      and nothing in the log. Proven by an attendee socket to the open MAIN-1 getting
      401, which only the origin check returns.
- [x] Fix:
      - origins compared ignoring case and a trailing "/"
      - origin refusal answers 403
      - each refused origin is logged once
      - the allowed list is printed at startup
      - presenter page and control console say what was refused instead of "waiting"
- [x] Control console: "Open session" (no mic) and "Copy presenter link" (enabled once
      open); "Start listening" still opens the session too. Loading the page no longer
      opens a session. Presenter page unchanged (auto-connects, no such buttons).
- [x] Verified:
      - attack.js 25/25 (new: foreign origin refused 403), with a messy
        ALLOWED_ORIGINS value
      - browser:
        - load: nothing opened
        - Open session: opened, link enabled
        - End session: buttons reset
        - Start listening reopened the session
        - presenter page on a refused origin names the cause
        - presenter page on an allowed origin connects
