# TekiLive

Real-time speaker captions, fanned out live to every attendee's own phone in
the language they choose. Runs as a normal hosted web app — a speaker talks
on stage, attendees anywhere (on cellular data, not just venue WiFi) open a
link, pick their language, and see live translated captions with a couple of
seconds of delay.

## Architecture

```
Presenter mic --(Web Speech API, in-browser STT)--> transcript segment
     --(WSS)--> server.js --(translation provider)--> per-language text
     --(WSS fan-out, one socket per phone)--> attendee caption screen
```

- A small Node.js server (Express + `ws`) sits in the middle: the
  presenter's mic feed goes to the server over a WebSocket, the server
  translates it into every language currently requested by connected
  attendees, and fans results out — each phone only receives the language
  it asked for. Nobody listening in a language means it's never translated
  into that language.
- Captions stream while the speaker is still talking, rather than waiting
  for a pause. The console (`public/stream-chunker.js`) watches the
  browser's live interim transcript and sends a chunk of roughly 6-10 words
  as soon as it has settled (holding back the last few words, which the
  recognizer keeps revising, and preferring to cut at a comma or full stop).
  The server translates each chunk immediately but delivers each language's
  chunks strictly in spoken order, and attendee screens append chunks to the
  current line until the phrase ends. Voice reads each chunk as it arrives.
- Translating a few words at a time is much worse than translating a whole
  sentence, so three things claw the quality back: (1) DeepL is sent the
  last ~300 characters of what the speaker just said as `context` — it reads
  it to disambiguate but neither translates nor bills it; (2) chunks are cut
  at commas/full stops where possible and never end on a linking word like
  "for", "how" or "want" (English source only, for now); (3) the stray full
  stop DeepL adds to a fragment that stops mid-sentence is dropped. Only
  DeepL uses the context — Azure and MyMemory translate each chunk alone, so
  expect noticeably rougher captions on them.
  How much the translator sees at once is the presenter's **Caption pacing**
  setting (remembered per browser, changeable mid-talk). Longer chunks
  translate better but reach attendees later. Measured against translating
  the same text in one go (similarity out of 100): **Fast** ≈ 82 at ~3s
  behind, **Balanced** (default) ≈ 86 at ~5s, **Best quality** ≈ 89 at ~7s.
  The exact sizes live in `PACES` in `stream-chunker.js`.
- The browser's speech engine is treated as unreliable, because it is. It
  stops by itself every so often, can fail to restart, and can hang on
  something it can't make out. The console keeps restarting it with backoff
  (and says so if the connection is unstable), replaces a run that has heard
  speech but returned no words for ~12s, and stops with a clear message only
  when the mic is blocked or missing. The chunker likewise copes with the
  recognizer discarding what it heard and starting a different phrase, so
  the words that follow are never swallowed.
- **Speaking two languages** *(built but switched off for now — set
  `ALT_LANG_ENABLED = true` in `public/control.html` to bring the option
  back).* The browser's speech engine listens in one
  language at a time; speech in any other comes back as finished results with
  no words in them. If the presenter sets **Also understand** to a second
  language, the console counts those empty results and, after two close
  together, switches the engine to the other language by itself (and back
  again the same way), labelling each chunk with the language it was really
  spoken in so it is translated from the right one. Changing **Speaker is
  talking in** mid-talk also applies straight away. This is recovery, not true
  mixed-language recognition: the words spoken before it notices are lost.
  Single words in the other language inside a sentence are usually fine — the
  engine writes them phonetically. For genuine mid-sentence switching a
  speech service with language identification (e.g. Azure Speech) is needed.
- Keep the presenter console in a visible window. Chrome delays speech
  results from a hidden tab (they arrive in bursts, seconds late), so the
  console warns when it is in the background while listening.
- DeepL's free tier rate-limits bursts; `translate.js` waits out a `429`
  briefly (up to two retries) instead of dropping the caption.
- Attendees join by scanning a QR code (or opening the join link directly)
  with their own phone. No app install.
- Attendees can also opt into hearing captions read aloud (a "Voice" toggle,
  off by default) using the phone's own on-device speech synthesis — no
  server round trip or additional API/account, so pair it with headphones.
- The presenter console shows a live audience count broken down by language,
  and live translation latency — both are things worth showing a client in
  the room.
- Sessions are isolated by a short code (`?session=MAIN`), so one deployment
  supports multiple concurrent panels/tracks at once. Any code works (letters,
  digits and `-`, up to 12 characters), but only the signed-in admin opens a
  session: on the control console with **Open session** (no mic needed) or
  **Start listening** (opens it and starts the mic), or by saving branding
  with that code. Loading the control console alone doesn't open anything.
  Once it is open, **Copy presenter link** is enabled there. At most `MAX_SESSIONS` (default 5, changeable live from the admin
  overview) are open at once. Attendees can only join
  an open session: if they scan before the presenter has opened it, the join
  page shows "Not started yet" and opens by itself when it starts. The admin
  overview lists open sessions and can **End session** to free a slot (for
  example one opened with a typo); its console and phones are told and
  disconnected. A session with no presenter, no audience and no branding
  closes by itself.
- **Presenter page** (`/present.html`): the speaker's own page, with no
  account. The admin hands each speaker that session's **presenter link**
  (shown on the control console and in the admin overview, "Copy presenter
  link"). It has the mic, spoken language, caption pacing, live transcript,
  audience count, and the attendee QR and join link to put on screen, but no
  branding upload, no session switching and no sign-in. A presenter link
  speaks into one session only, and only once the admin has opened it: it
  can't create, brand or end sessions. It is the same console code as the
  control page, so speech-engine fixes apply to both.
- Each session carries its own event/organizer branding (name + logo),
  uploaded by the presenter and shown to that session's attendees — see
  Branding below.

## Requirements

- Node.js 22 or 24. Both are tested with the full load and security suite
  (`loadtest/`); `package.json` still allows 18+, but 18 and 20 are end of life.
  On Azure App Service use `NODE:24-lts` (supported until 2028-04) or
  `NODE:22-lts` (until 2027-04).
- Desktop Chrome or Edge for the presenter console (Web Speech API support)
- A public HTTPS deployment — see below. Microphone access and WebSockets
  both require a secure context, so this won't work reliably served over
  plain HTTP.

## Configuration (environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | Port the server listens on (hosting platforms set this for you) |
| `ALLOWED_ORIGINS` | recommended in production | *(empty = allow all)* | Comma-separated list of origins allowed to open a WebSocket connection, e.g. `https://<app>.azurewebsites.net`. Set it on the live deployment so another website can't open a presenter connection using a signed-in admin's cookie. Case and a trailing `/` don't matter. When it is set, every other origin is refused, **including `http://localhost:3000` on a local run**: add it to the list or leave the setting out of your local `.env`. The server prints the allowed list at startup and logs each refused origin |
| `DEEPL_API_KEY` | recommended | *(empty)* | DeepL API key. When set, this becomes the translation provider (see below) |
| `AZURE_TRANSLATOR_KEY` | alternative | *(empty)* | Azure Translator API key, used only if no DeepL key is set |
| `AZURE_TRANSLATOR_REGION` | with the key above | *(empty)* | Azure resource region, e.g. `eastus` |
| `MYMEMORY_EMAIL` | no | *(empty)* | Optional email passed to the free MyMemory API (only used as a last-resort fallback when no other provider is set) for a higher rate limit |
| `NODE_ENV` | in production | *(empty)* | Set to `production` on the live deployment. The server then refuses to start unless `SESSION_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set (see Accounts), and the login cookie is sent over HTTPS only |
| `SESSION_SECRET` | yes | *(empty)* | Random string (at least 32 characters) used to sign the admin login cookie and to derive presenter-link keys. Needed to sign in to the control console and the admin overview, everywhere including local runs |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | *(empty)* | The one admin account (password at least 12 characters). Needed to sign in to the control console and the admin overview, everywhere including local runs |
| `MAX_SESSIONS` | no | `5` | Default for how many sessions can be open at once (1-100). The admin overview can change it live; that override lasts until a restart. Opening one more is refused until a session ends; lowering it never closes open sessions |
| `DEEPL_API_URL` | no | *(empty)* | Overrides the DeepL endpoint. Only for the load test's mock translator (`loadtest/`); leave unset |
| `LOG_FILE` | no | *(empty)* | Also write the server log to this file (relative to the app folder), e.g. `tekilive-debug.log`. Handy for looking at a problem afterwards; kept under 5MB |
| `CLIENT_LOG` | no | *(empty)* | Set to `1` to let the presenter console report what its speech engine and caption pipeline are doing into the same log (includes transcript snippets). Leave off in production |

Copy `.env.example` to `.env` for local runs if you want to set these; most
hosting platforms let you set them directly in their dashboard instead.

### Translation provider

By default `translate.js` picks DeepL when `DEEPL_API_KEY` is set, Azure Translator
when `AZURE_TRANSLATOR_KEY` is set instead, and falls back to the free
MyMemory API otherwise. **The MyMemory fallback is for local development
only** — its anonymous quota is small (and shared across whatever IP a
request comes from, including other apps on the same cloud host), so it
will hit "quota exhausted" errors under any real usage.

For an actual deployment, get a free DeepL API key:

1. [deepl.com/pro-api](https://www.deepl.com/en/pro-api) → sign up for
   **DeepL API Free** (500,000 characters/month free; a card is required
   at signup but isn't charged on the free plan).
2. Once approved, find your key at
   [deepl.com/your-account/keys](https://www.deepl.com/en/your-account/keys).
   Free-tier keys end in `:fx` — `translate.js` uses that suffix to route
   to the correct (free vs. pro) API host automatically.
3. Set `DEEPL_API_KEY` in your hosting platform's environment variables.

**DeepL Free is not enough for a full event day.** Each caption is translated
once per language in use, so volume grows with the number of languages, not
attendees. Two sessions talking for 5-6 hours into 3-5 languages is roughly
1.6M-3.7M characters (an estimate from typical speaking rates; see
`tasks/todo.md`), several times the Free plan's 500,000/month. Use a paid
DeepL plan or Azure Translator for the event. If the quota runs out mid-talk,
the presenter console reports "translation quota used up" and you can switch
provider live from the admin overview (below).

**Caveat:** DeepL doesn't support Hindi, one of the ten languages in this
app's language list — selecting it as a target will error. Everything else
(English, Arabic, French, Spanish, German, Chinese, Portuguese, Russian,
Turkish) is supported.

**Switching provider live.** The admin overview (`/admin.html`) has a
**Translation provider** card: pick DeepL, Azure Translator or MyMemory, enter
its key (and region for Azure), and press **Test & switch**. The server runs a
test translation first and only switches if it succeeds, so a mistyped key
leaves captions running on the current provider. The switch applies from the
next caption, for both sessions, with no restart. **Reset to defaults** goes
back to the env-configured provider above. The dashboard choice is held in
memory, so a server restart also goes back to the env provider: keep the main
event key in the env settings and use the dashboard for switching on the day
(for example when the presenter console reports "translation quota used up").
The full key is never sent back to the browser, only its last 4 characters.

Adding a different provider (Google Cloud Translation, etc.) later is a
one-file change: add another `translate<Provider>()` function in
`translate.js` and register it in `PROVIDERS`.

## Branding

Two layers, both visible on the presenter console, the audience language
picker, and the audience caption screen:

- **TekiMinds** — a static, always-on brand mark on every page. Drop the
  logo file at `public/branding/tekiminds-logo.png` and it takes over from
  the placeholder "TL" mark automatically (all three pages fall back to the
  placeholder gracefully if that file is missing, so nothing breaks before
  it's added).
- **Event + organizer branding** — set per session, not global. On the
  control console, fill in the event name / organizer name and upload
  their logos (500 KB max each, PNG, JPEG or WebP) under "Event
  branding," then **Save branding**. It's fanned out live over the existing
  WebSocket to every attendee already connected (no reload needed), and
  future joiners pick it up from `GET /api/session/:code/branding` before
  they even pick a language.

Branding lives in memory on the session, like everything else in this
app — no cloud storage account needed — but it survives the *normal* churn
of a live event: a presenter's browser refreshing, or a lull with zero
attendees connected, no longer wipes it out (only true server restarts do,
same as every other piece of session state — see "no persistence" below).
Set it once, shortly before the event starts.

## Accounts

One admin account, defined by env settings: `ADMIN_EMAIL`, `ADMIN_PASSWORD`
and `SESSION_SECRET`. No database. Signing in is required to:

- run the control console (`/control.html`) for any session code: open the
  session, show its QR, set branding, copy the presenter link,
- change a session's branding,
- open the admin overview (`/admin.html`): every open session (presenter
  connected or not, live audience per language, branding) with **Copy
  presenter link** and **End session**, the session limit, and the
  translation provider card.

Speakers don't need the admin account: give each one the session's presenter
link (see Presenter page above). The link carries a key after `#`, which the
browser never sends to the server; the page passes it to the caption socket
as a WebSocket subprotocol, so it never appears in a URL the server logs. The
key is derived from `SESSION_SECRET` and the session code, so the same link
works again after a server restart once the admin reopens the session. To
revoke a leaked link, use a different session code; changing
`SESSION_SECRET` revokes every link (and every admin sign-in).

After 10 failed sign-ins from one address, further
attempts from it are refused for 15 minutes. At a venue, attendees usually
share one public address with the presenter laptops, so someone there could
trigger that lock. Sign in before doors open (a sign-in lasts 12 hours), and if
the lock does hit, sign in over mobile data instead of the venue Wi-Fi.

Enforcement isn't just a login screen on top of an open backend: the
WebSocket connection a presenter console uses to actually stream captions
checks the session cookie server-side too. Audience join links are
deliberately **not** gated — attendees scanning a QR code should never need
an account.

Sign-in is required on both the control console and the admin overview,
everywhere, local runs included. One sign-in works on both pages, since they
share the same login cookie. Without the three settings nobody can sign in, so
set them for local runs too. In production (`NODE_ENV=production`) the server
also refuses to start without them. Once signed in,
each page has a header link to the other. If the sign-in expires mid-talk, the
console shows the sign-in screen again instead of retrying the connection.

## Run it locally

Set `SESSION_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` before `npm start`
(in the shell, or in a `.env` file for local runs), or nobody can sign in to
the presenter console or the admin overview. The server prints which ones are
missing at startup. In PowerShell:

```powershell
$env:SESSION_SECRET = "<random string, at least 32 characters>"
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "<at least 12 characters>"
```

`SESSION_SECRET` must be at least 32 characters for production and
`ADMIN_PASSWORD` at least 12.

```bash
npm install
npm start
```

Open `http://localhost:3000/control.html` for the presenter console and
`http://localhost:3000/join.html?session=MAIN` for the audience view. Note:
the Web Speech API requires a secure context in most browsers, so mic
capture may not work over plain `http://localhost` in all browsers — deploy
to test the full flow, or use a browser that allows it on localhost.

## Security

What the server enforces, each covered by a check in `loadtest/attack.js`:

- **Crash resistance:** a malformed WebSocket frame, a `null` message or a bad
  `Host` header is refused without taking the server down. Messages are capped
  at 16 KB. A last-resort handler logs any unexpected exception instead of
  exiting; the load-test runner fails any run that logs one.
- **Presenter and admin:** sign-in required for the console, the caption
  socket, branding uploads and every `/api/admin/*` route. The JWT is pinned to
  HS256, credentials are compared in constant time, failed sign-ins are
  limited per address.
- **Sessions:** only the signed-in admin can open one, at most the session
  limit at once, so attendees and presenter links can neither create sessions
  nor use up the slots. Codes must be letters, digits and `-` (up to 12), so
  nothing odd reaches URLs or the log. Changing the limit is admin-only and
  validated (1-100).
- **Presenter links:** a per-session key compared in constant time, sent as a
  WebSocket subprotocol (never in a logged URL), valid only for an open
  session; the server echoes only the protocol name, never the key. The
  presenter page is served with `Referrer-Policy: no-referrer`.
- **Attendee input:** only the ten supported languages are accepted, so nobody
  can trigger translations into made-up languages.
- **Logos:** PNG, JPEG or WebP only, 500 KB max, served with `nosniff` and a
  `default-src 'none'` content security policy (an uploaded SVG could
  otherwise run script on the app's origin).
- **Headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, no
  `X-Powered-By`.
- **Provider keys:** settable from the admin overview, never sent back to the
  browser (only the last 4 characters), and endpoints are env-only.

An OWASP Top 10 (2025) review found no critical or high gaps. Open low/medium
items, by choice for a one-day event: set `ALLOWED_ORIGINS` in production;
check that the sign-in limiter sees the real client address behind your host's
proxy; no total connection cap; failed sign-ins aren't logged; no HSTS or
Referrer-Policy header; a sign-in stays valid for its 12 hours after logout.

## Capacity and load testing

`loadtest/` runs the server with a mock translator (no real provider is
called) and plays hundreds to thousands of attendee phones plus the
presenters. See `loadtest/README.md` for how to run it.

Measured on a Linux network stack (WSL2, Node 22 and 24), two sessions talking
at once, mock translator answering in 300 ms:

| Attendees | Delivered | Latency p95 (server) | Event loop busy (max) | Memory |
|---|---|---|---|---|
| 500 (250 per session, 5 languages) | 100%, in order | about 350-430 ms | 4-15% | 86-101 MB |
| 1,000 (9 languages) | 100%, in order | about 410-530 ms | 12-19% | 112-135 MB |
| 5,000 (9 languages) | 100%, in order | about 590-840 ms | 51-77% | 137-199 MB |

The latency includes the mock's 300 ms, so the server adds about 50-130 ms at
event size. A reconnect storm (every phone dropping at once) recovers in
2-5 s without re-downloading logos, and a provider switch mid-talk loses no
captions. These are a developer laptop's CPU cores; a cloud vCPU may be
slower, so rehearse on the real host.

The real limits are elsewhere:

- **Hosting tier:** every phone holds one WebSocket. Azure App Service Free
  allows 5 per instance and Windows Basic 350; Linux Basic (B1) and above allow
  about 50,000. Run a single instance: all session state is in memory, so a
  second instance would split presenters from their audience.
- **Translation quota** (see Translation provider above).

## Deploying to Render

Render was chosen because it runs your Node process persistently (unlike
serverless platforms, which drop long-lived WebSocket connections), it
provisions HTTPS/WSS automatically on a real public URL, and it deploys
straight from a GitHub repo with no extra config for a Node + WebSocket app.

**Pick a region close to your actual audience, not just the default.**
Render's region is fixed at creation (changing it later means creating a
new service). DeepL's API is EU-based, so for an EMEA audience Frankfurt
measured roughly half the latency of the US-West default — 140-190ms per
translation call there vs. 300-380ms from Oregon, end to end. For a US
audience, Ohio/Virginia/Oregon are all fine; for APAC, Singapore is closer
to attendees but translation calls still cross to DeepL's EU servers either
way.

1. Push this project to a GitHub repository.
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** →
   **Web Service**, and connect the GitHub repo. (If your Render account's
   connected GitHub identity differs from the one that owns this repo, use
   the **Public Git Repository** option instead and paste the repo's HTTPS
   URL — this works for a public repo without linking accounts, but loses
   auto-deploy-on-push; redeploy manually from the dashboard after each
   push, or reconnect the matching GitHub account later to restore it.)
3. Render should auto-detect the `render.yaml` in this repo (a "Blueprint")
   and pre-fill the service — this only works with the GitHub-connected
   path. Via the public-repo-URL path, configure manually instead:
   - **Runtime:** Node
   - **Region:** whichever is closest to your audience (see above)
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/healthz`
4. Set `ALLOWED_ORIGINS` to the service's own URL (e.g.
   `https://<service-name>.onrender.com`). Set `DEEPL_API_KEY` (see Translation
   provider above) so captions don't rely on the unreliable MyMemory fallback.
   For a live event also set `NODE_ENV=production`, `SESSION_SECRET`,
   `ADMIN_EMAIL` and `ADMIN_PASSWORD` (see Accounts above).
5. Deploy. Render builds and gives you a public URL like
   `https://<service-name>.onrender.com` — HTTPS and WSS both work on it
   automatically, no extra config. Note the `.onrender.com` subdomain is
   fixed to whatever name you gave the service at creation — renaming the
   service later changes its display name only, not the URL.
6. Open `https://<your-url>/control.html` on your laptop (start listening,
   pick a session code) and `https://<your-url>/join.html?session=<code>`
   — or the QR code shown on the presenter console — on a phone. Test the
   phone **on cellular data, not the same WiFi**, since that's the actual
   requirement this refactor is meant to satisfy.

**Free-tier instances spin down after ~15 minutes of inactivity**, and the
next request then takes 50+ seconds to wake it back up — this is
indistinguishable from "the app is broken" if it happens mid-demo. It only
bites the *first* request after a gap; once warm, response times are normal.
For an actual live event, upgrade to a paid instance (Starter, ~$7/month)
beforehand so it never sleeps.

## What's still a placeholder, worth flagging honestly in the pitch

- **Translation engine:** DeepL in production (set `DEEPL_API_KEY`), with
  Azure Translator as an alternative and MyMemory as an unauthenticated
  local-dev fallback. Isolated behind one function (`translate.js`), so
  swapping providers later is a one-file change. Note DeepL doesn't cover
  Hindi — see the Translation provider section above.
- **No persistence:** transcripts/captions/branding aren't saved anywhere
  durable — a server restart or redeploy loses them, same as the rest of
  session state. Fine for a single scheduled event set up shortly
  beforehand; adding a real datastore would unlock branding (and a
  post-event transcript/summary deliverable) surviving restarts.
- **No auth on audience links:** by design — anyone with the QR/URL can
  join a session as an attendee. The presenter console and admin overview
  always require the admin sign-in (see Accounts above); audience join
  links stay open.
