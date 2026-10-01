/**
 * Runs one load scenario end to end on this machine: starts the mock
 * translator and the server (with probe.js preloaded), runs load.js or
 * attack.js against it, stops both, and writes loadtest/results/<label>.json
 * (the client's result plus the server's own CPU/memory/event-loop peaks).
 *
 *   node loadtest/run.js --label=before-steady-500 --profile=before -- --mode=steady --audience=500
 *   node loadtest/run.js --label=after-attack --profile=after --script=attack
 *
 * Profiles (server env):
 *   before  the original setup: no accounts, any session code, Azure path to the mock.
 *           Historical: the current code refuses the speaker socket without an
 *           admin sign-in, so this profile only reproduces the baseline against the
 *           original commit (9c31216), not against today's code.
 *   after   the event setup: NODE_ENV=production, admin login, sessions MAIN and MAIN-2,
 *           DeepL path to the mock (Azure configured too, for the live-switch test)
 *
 * Throwaway admin credentials are generated per run and never written to disk.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RESULTS = path.join(__dirname, 'results');
const PORT = 3100;
const MOCK_PORT = 3199;

const sep = process.argv.indexOf('--');
const own = Object.fromEntries(process.argv.slice(2, sep < 0 ? undefined : sep).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
const passThrough = sep < 0 ? [] : process.argv.slice(sep + 1);
const label = own.label || `run-${Date.now()}`;
const profile = own.profile || 'before';
const script = own.script === 'attack' ? 'attack.js' : 'load.js';
const mockDelay = own['mock-delay'] || '300';

const admin = { email: 'loadtest@example.test', password: crypto.randomBytes(18).toString('base64url') };
const base = `http://127.0.0.1:${PORT}`;
const mockUrl = `http://127.0.0.1:${MOCK_PORT}`;

const profiles = {
  before: {
    AZURE_TRANSLATOR_KEY: 'mock-azure-key',
    AZURE_TRANSLATOR_REGION: 'westeurope',
    AZURE_TRANSLATOR_ENDPOINT: mockUrl,
  },
  after: {
    NODE_ENV: 'production',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_EMAIL: admin.email,
    ADMIN_PASSWORD: admin.password,
    ALLOWED_ORIGINS: base,
    DEEPL_API_KEY: 'mock-deepl-key',
    DEEPL_API_URL: `${mockUrl}/v2/translate`,
    AZURE_TRANSLATOR_ENDPOINT: mockUrl,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`${url} did not come up`);
}

function summarizeProbe(file) {
  if (!fs.existsSync(file)) return null;
  // slice(2): header row, then the first sample, which covers server startup
  // (module loading reads as 100% busy with an empty delay histogram).
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(2).map((l) => l.split(','));
  if (!rows.length) return null;
  const col = (i) => rows.map((r) => Number(r[i]));
  const max = (a) => Math.max(...a);
  return {
    samples: rows.length,
    loopP99MaxMs: max(col(2)),
    loopMaxMs: max(col(3)),
    eluPctMax: max(col(4)),
    cpuPctMax: max(col(5)),
    cpuPctAvg: +(col(5).reduce((a, b) => a + b, 0) / rows.length).toFixed(1),
    rssMbMax: max(col(6)),
    heapMbMax: max(col(7)),
  };
}

// The server logs "translated en->fr in 412ms" per caption: time from the
// chunk arriving to it being sent to phones, measured on the server's clock.
function serverLatency(logFile) {
  const text = fs.readFileSync(logFile, 'utf8');
  const ms = [...text.matchAll(/translated \w+->\w+ in (\d+)ms/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!ms.length) return null;
  const p = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  return { n: ms.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: ms[ms.length - 1] };
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const probeFile = path.join(RESULTS, `${label}-probe.csv`);
  const serverLogFile = path.join(RESULTS, `${label}-server.log`);
  const serverLog = fs.openSync(serverLogFile, 'w');

  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-translator.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DELAY_MS: mockDelay }, stdio: 'ignore',
  });
  const server = spawn(process.execPath, ['-r', path.join(__dirname, 'probe.js'), 'server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(PORT), PROBE_OUT: probeFile, ...profiles[profile] },
    stdio: ['ignore', serverLog, serverLog],
  });
  let serverExit = null;
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });

  try {
    await waitFor(`${mockUrl}/stats`, 10000);
    await waitFor(`${base}/healthz`, 15000);
    const client = spawn(process.execPath, [path.join(__dirname, script), `--base=${base}`, `--mock-delay=${mockDelay}`, ...passThrough], {
      env: { ...process.env, ...(profile === 'after' ? { ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: admin.password } : {}) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    client.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    const clientExit = await new Promise((r) => client.on('exit', r));
    await sleep(5500); // one more probe sample after the load stops
    const mockStats = await (await fetch(`${mockUrl}/stats`)).json().catch(() => null);

    const result = {
      label, profile, script, clientExit, serverExit,
      server: summarizeProbe(probeFile), serverLatencyMs: serverLatency(serverLogFile), mock: mockStats,
      // server.js survives a stray throw by logging it; any count above 0 is a bug.
      uncaughtExceptions: (fs.readFileSync(serverLogFile, 'utf8').match(/UNCAUGHT EXCEPTION/g) || []).length,
    };
    if (script === 'load.js') {
      try { result.client = JSON.parse(out.slice(out.indexOf('{'))); } catch { result.clientRaw = out; }
    } else {
      result.attack = out;
    }
    fs.writeFileSync(path.join(RESULTS, `${label}.json`), JSON.stringify(result, null, 2));
    console.log(`\nserver: ${JSON.stringify(result.server)}  exit: ${JSON.stringify(serverExit)}`);
    console.log(`saved loadtest/results/${label}.json`);
  } finally {
    server.kill();
    mock.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
