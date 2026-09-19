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
  To trade smoothness for speed, tune `commitAt` / `holdBack` in
  `stream-chunker.js` — smaller numbers mean shorter, faster chunks but
  choppier translations (translating a few words at a time gives the
  translator less context than a whole sentence).
- Attendees join by scanning a QR code (or opening the join link directly)
  with their own phone. No app install.
- Attendees can also opt into hearing captions read aloud (a "Voice" toggle,
  off by default) using the phone's own on-device speech synthesis — no
  server round trip or additional API/account, so pair it with headphones.
- The presenter console shows a live audience count broken down by language,
  and live translation latency — both are things worth showing a client in
  the room.
- Sessions are isolated by a short code (`?session=DEMO`), so one deployment
  already supports multiple concurrent panels/tracks at once — give each
  panel its own code.
- Each session carries its own event/organizer branding (name + logo),
  uploaded by the presenter and shown to that session's attendees — see
  Branding below.

## Requirements

- Node.js 18+ (uses the built-in `fetch`)
- Desktop Chrome or Edge for the presenter console (Web Speech API support)
- A public HTTPS deployment — see below. Microphone access and WebSockets
  both require a secure context, so this won't work reliably served over
  plain HTTP.

## Configuration (environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | Port the server listens on (hosting platforms set this for you) |
| `ALLOWED_ORIGINS` | no | *(empty = allow all)* | Comma-separated list of origins allowed to open a WebSocket connection, e.g. `https://tekilive.onrender.com` |
| `DEEPL_API_KEY` | recommended | *(empty)* | DeepL API key. When set, this becomes the translation provider (see below) |
| `AZURE_TRANSLATOR_KEY` | alternative | *(empty)* | Azure Translator API key, used only if no DeepL key is set |
| `AZURE_TRANSLATOR_REGION` | with the key above | *(empty)* | Azure resource region, e.g. `eastus` |
| `MYMEMORY_EMAIL` | no | *(empty)* | Optional email passed to the free MyMemory API (only used as a last-resort fallback when no other provider is set) for a higher rate limit |
| `DATABASE_URL` | for accounts | *(empty)* | Postgres connection string. Only needed for presenter-console login and the admin overview — see Accounts below |
| `SESSION_SECRET` | for accounts | *(empty)* | Random string used to sign login sessions. Required alongside `DATABASE_URL` for accounts to activate |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first deploy only | *(empty)* | Bootstraps one admin account on startup if no admin exists yet. Safe to leave set — bootstrap is a no-op once that admin already exists |

Copy `.env.example` to `.env` for local runs if you want to set these; most
hosting platforms let you set them directly in their dashboard instead.

### Translation provider

`translate.js` picks DeepL when `DEEPL_API_KEY` is set, Azure Translator
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

**Caveat:** DeepL doesn't support Hindi, one of the ten languages in this
app's language list — selecting it as a target will error. Everything else
(English, Arabic, French, Spanish, German, Chinese, Portuguese, Russian,
Turkish) is supported.

Swapping to a different provider (Google Cloud Translation, etc.) later is
a one-file change — add another `translate<Provider>()` function in
`translate.js` and branch to it in `translate()`.

## Branding

Two layers, both visible on the presenter console, the audience language
picker, and the audience caption screen:

- **TekiMinds** — a static, always-on brand mark on every page. Drop the
  logo file at `public/branding/tekiminds-logo.png` and it takes over from
  the placeholder "TL" mark automatically (all three pages fall back to the
  placeholder gracefully if that file is missing, so nothing breaks before
  it's added).
- **Event + organizer branding** — set per session, not global. On the
  presenter console, fill in the event name / organizer name and upload
  their logos (2MB max each, any common image format) under "Event
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

Two roles, both optional — leave `DATABASE_URL`/`SESSION_SECRET` unset and
the presenter console stays exactly as open as before (no login, anyone
with the URL can run any session), which is still fine for a single-track
demo. Set them both to turn on:

- **Stage managers** — one account per stage/track, each pre-assigned to
  a specific session code by an admin. Logging in at `/control.html` takes
  them straight to their stage's console (session code locked, can't be
  changed or mixed up with another track) and lets them pick the spoken
  language, start/stop listening, and set that stage's branding, same as
  the console always worked.
- **Admins** — sign in at `/admin.html` to see every currently active
  session at a glance (presenter connected or not, live audience count per
  language, event branding) and to create/remove stage manager accounts.
  The very first admin is bootstrapped automatically from `ADMIN_EMAIL` /
  `ADMIN_PASSWORD` on server startup; every admin after that is created
  from the admin overview page itself.

Enforcement isn't just a login screen on top of an open backend: the
WebSocket connection a presenter console uses to actually stream captions
checks the session cookie server-side too, so a stage manager genuinely
cannot connect to (or interfere with) a different stage's session, even by
hand-crafting a request. Audience join links are deliberately **not**
gated — attendees scanning a QR code should never need an account.

Accounts are the one thing in this app backed by a real database instead
of memory, since — unlike a session's captions or branding — losing every
account on a server restart mid-event would be a real problem. A session's
own state (captions, connected audience, branding) still lives in memory
exactly as before; only the `users` table is durable.

## Run it locally

```bash
npm install
npm start
```

Open `http://localhost:3000/control.html` for the presenter console and
`http://localhost:3000/join.html?session=DEMO` for the audience view. Note:
the Web Speech API requires a secure context in most browsers, so mic
capture may not work over plain `http://localhost` in all browsers — deploy
to test the full flow, or use a browser that allows it on localhost.

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
4. Leave `ALLOWED_ORIGINS` blank unless you want to lock the WebSocket down
   to a specific domain later. Set `DEEPL_API_KEY` (see Translation provider
   above) so captions don't rely on the unreliable MyMemory fallback.
   If you want stage-manager/admin logins (see Accounts above), also
   create a Postgres instance ([dashboard.render.com](https://dashboard.render.com)
   → **New** → **Postgres** — the free tier works but auto-expires after
   30 days, fine for testing, upgrade to a paid instance before a real
   event), then set `DATABASE_URL` to its connection string, `SESSION_SECRET`
   to any random string, and `ADMIN_EMAIL`/`ADMIN_PASSWORD` to your first
   admin login. Skip all four to keep the console open with no login.
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
  join a session as an attendee. The presenter console *can* be gated
  behind stage-manager/admin accounts (see Accounts above) if you want
  that; audience join links stay open either way.
