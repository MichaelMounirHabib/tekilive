# Load and security tests

Local harness for the event setup (two sessions, `MAIN` and `MAIN-2`). No extra
dependencies: it uses `ws` from the app and Node's standard library. No real
translation provider is ever called; `mock-translator.js` answers in DeepL's and
Azure's response shapes after a fixed delay.

| File | What it does |
|---|---|
| `suite.js` | Runs every scenario for one profile and prints a summary table |
| `run.js` | Runs one scenario: starts the mock and the server (with `probe.js`), runs the client, saves `results/<label>.json` |
| `load.js` | The client: N attendee phones per session plus one speaker per session |
| `attack.js` | Security regression checks, one per finding. PASS = protected |
| `probe.js` | Preloaded into the server; samples event-loop delay/utilization, CPU, memory |
| `mock-translator.js` | Stand-in for DeepL and Azure Translator |

```bash
node loadtest/suite.js after          # all scenarios against the current code, event setup
node loadtest/suite.js after B4-attack  # one scenario
```

Profiles: `before` ran the original code (commit 9c31216) with no accounts and any session code.
It is kept for reference only: today's code refuses the speaker socket without an admin
sign-in, so `before` runs against it record every speaker as rejected.
`after` runs `NODE_ENV=production` with a generated throwaway admin login,
`SESSION_CODES=MAIN,MAIN-2`, and DeepL pointed at the mock. Results go to
`loadtest/results/` (git-ignored).

`load.js` also works against a deployed URL, for example:

```bash
node loadtest/load.js --base=https://<app> --mode=steady --sessions=MAIN,MAIN-2 --audience=250 --langs=fr,es,de,ar,zh --admin-email=... --admin-password=...
```

Against a real deployment captions go through the real provider and are billed.
Use `--langs=en` (the speaker's own language) to test fan-out without translation.

Known gap: the test speaker does not reconnect. The real console does, and it holds
chunks until it is back. If the network drops the test speaker's socket, the rest of that
run's captions are counted as lost.

## Reading the numbers

- `delivered`: captions received out of captions expected, across all phones.
- `p95ms`: end-to-end latency seen by the test client, including the mock's 300 ms.
- `srvP95ms`: the same measured on the server's clock (chunk in to caption out).
- `eluMax`: the highest share of a 5 s window the server's event loop was busy.

On Windows, loopback networking on a machine with endpoint security can reset
connections and delay new ones by about 3 s (a dropped SYN being retried) once
roughly 500-1000 sockets are open. Both ends then see `ECONNRESET` at the same moment,
which is how to tell it apart from an app problem. Numbers above that range are
only meaningful on a Linux network stack (WSL2, a container, or the real host).
