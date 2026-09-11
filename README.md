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
  translates each finished sentence into every language currently requested
  by connected attendees, and fans results out — each phone only receives
  the language it asked for. Nobody listening in a language means it's never
  translated into that language.
- Attendees join by scanning a QR code (or opening the join link directly)
  with their own phone. No app install.
- The presenter console shows a live audience count broken down by language,
  and live translation latency — both are things worth showing a client in
  the room.
- Sessions are isolated by a short code (`?session=DEMO`), so one deployment
  already supports multiple concurrent panels/tracks at once — give each
  panel its own code.

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
| `AZURE_TRANSLATOR_KEY` | recommended | *(empty)* | Azure Translator API key. When set, this becomes the translation provider (see below) |
| `AZURE_TRANSLATOR_REGION` | with the key above | *(empty)* | Azure resource region, e.g. `eastus` |
| `MYMEMORY_EMAIL` | no | *(empty)* | Optional email passed to the free MyMemory API (only used as a fallback when no Azure key is set) for a higher rate limit |

Copy `.env.example` to `.env` for local runs if you want to set these; most
hosting platforms let you set them directly in their dashboard instead.

### Translation provider

`translate.js` picks Azure Translator when `AZURE_TRANSLATOR_KEY` is set,
and falls back to the free MyMemory API otherwise. **The MyMemory fallback
is for local development only** — its anonymous quota is small (and shared
across whatever IP a request comes from, including other apps on the same
cloud host), so it will hit "quota exhausted" errors under any real usage.
For an actual deployment, get a free Azure Translator key:

1. [portal.azure.com](https://portal.azure.com) → **Create a resource** →
   search **Translator** → create it on the **F0 (free)** pricing tier
   (2 million characters/month free).
2. Once created, open the resource → **Keys and Endpoint**, and copy **Key 1**
   and the **Region**.
3. Set `AZURE_TRANSLATOR_KEY` and `AZURE_TRANSLATOR_REGION` in your hosting
   platform's environment variables.

Swapping in a different provider (DeepL, Google Cloud Translation) later is
a one-file change — add another `translate<Provider>()` function in
`translate.js` and branch to it in `translate()`.

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

1. Push this project to a GitHub repository.
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** →
   **Web Service**, and connect the GitHub repo.
3. Render should auto-detect the `render.yaml` in this repo (a "Blueprint")
   and pre-fill the service. If it doesn't, configure manually:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/healthz`
4. Leave `ALLOWED_ORIGINS` blank unless you want to lock the WebSocket down
   to a specific domain later. Set `MYMEMORY_EMAIL` if you have one.
5. Click **Create Web Service**. Render builds and deploys, and gives you a
   public URL like `https://tekilive.onrender.com` — HTTPS and WSS both work
   on it automatically, no extra config.
6. Open `https://tekilive.onrender.com/control.html` on your laptop (start
   listening, pick a session code) and `https://tekilive.onrender.com/join.html?session=<code>`
   — or the QR code shown on the presenter console — on a phone. Test the
   phone **on cellular data, not the same WiFi**, since that's the actual
   requirement this refactor is meant to satisfy.

Free-tier Render services spin down after inactivity and take ~30-60s to
wake on the next request — fine for a scheduled demo, worth knowing if the
presenter console feels slow to connect after idling. Upgrade to a paid
instance to avoid that for a live event.

## What's still a placeholder, worth flagging honestly in the pitch

- **Translation engine:** Azure Translator in production (set
  `AZURE_TRANSLATOR_KEY`), MyMemory as an unauthenticated local-dev fallback.
  Isolated behind one function (`translate.js`), so swapping to DeepL or
  Google Cloud Translation later is a one-file change.
- **No persistence:** transcripts/captions aren't saved anywhere. Adding a
  session log would unlock a post-event transcript/summary deliverable.
- **No auth on sessions:** anyone with the QR/URL can join a session. Fine
  for an open panel, worth adding a passcode for anything private.
