/**
 * Runs the full local scenario set for one profile, one scenario at a time,
 * and prints a summary table. Same scenarios before and after the fixes, so
 * the numbers compare directly.
 *
 *   node loadtest/suite.js before    # original code and setup
 *   node loadtest/suite.js after     # hardened code, event setup
 *   node loadtest/suite.js after B2  # just one scenario
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const profile = process.argv[2] || 'before';
const only = process.argv[3];
const client = profile === 'after' ? 'new' : 'old';
const FIVE = 'fr,es,de,ar,zh';
const NINE = 'fr,es,de,ar,zh,pt,ru,hi,tr';
const TWO = 'MAIN,MAIN-2';

const scenarios = [
  { id: 'B1-500', args: ['--mode=steady', '--sessions=MAIN', '--audience=500', `--langs=${NINE}`] },
  { id: 'B1-1000', args: ['--mode=steady', '--sessions=MAIN', '--audience=1000', `--langs=${NINE}`] },
  { id: 'B1-1500', args: ['--mode=steady', '--sessions=MAIN', '--audience=1500', `--langs=${NINE}`, '--ramp=15000'] },
  { id: 'B1b-250x2', args: ['--mode=steady', `--sessions=${TWO}`, '--audience=250', `--langs=${FIVE}`] },
  { id: 'B1b-500x2', args: ['--mode=steady', `--sessions=${TWO}`, '--audience=500', `--langs=${FIVE}`] },
  { id: 'B1b-500x2-9lang', args: ['--mode=steady', `--sessions=${TWO}`, '--audience=500', `--langs=${NINE}`] },
  { id: 'B2-storm-250x2', args: ['--mode=storm', `--sessions=${TWO}`, '--audience=250', `--langs=${FIVE}`, '--logo-kb=500'] },
  { id: 'B3-burst-250x2', args: ['--mode=burst', `--sessions=${TWO}`, '--audience=250', `--langs=${FIVE}`, '--logo-kb=500', '--ramp=5000'] },
  { id: 'B5-switch-250x2', args: ['--mode=switch', `--sessions=${TWO}`, '--audience=250', `--langs=${FIVE}`], afterOnly: true },
  { id: 'B4-attack', script: 'attack' },
];

const rows = [];
for (const s of scenarios) {
  if (only && s.id !== only) continue;
  if (s.afterOnly && profile !== 'after') continue;
  const label = `${profile}-${s.id}`;
  console.log(`\n=== ${label} ===`);
  const runArgs = [path.join(__dirname, 'run.js'), `--label=${label}`, `--profile=${profile}`];
  if (s.script) runArgs.push(`--script=${s.script}`);
  else runArgs.push('--', `--client=${client}`, '--duration=60', ...s.args);
  spawnSync(process.execPath, runArgs, { stdio: ['ignore', 'ignore', 'inherit'] });

  const file = path.join(__dirname, 'results', `${label}.json`);
  if (!fs.existsSync(file)) { rows.push({ id: s.id, error: 'no result' }); continue; }
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = r.client || {};
  rows.push({
    id: s.id,
    attendees: c.attendees,
    delivered: c.deliveredPct,
    outOfOrder: c.outOfOrder,
    p95ms: c.latencyMs && c.latencyMs.p95,
    srvP95ms: r.serverLatencyMs && r.serverLatencyMs.p95,
    srvMaxMs: r.serverLatencyMs && r.serverLatencyMs.max,
    eluMax: r.server && r.server.eluPctMax,
    cpuMax: r.server && r.server.cpuPctMax,
    rssMb: r.server && r.server.rssMbMax,
    storm: c.storm ? `${c.storm.recoverMs}ms ${c.storm.logoMB}MB` : '',
    burst: c.burst ? `p95 ${c.burst.joinMs.p95}ms` : '',
    logoMB: c.logoMB,
    switch: c.switch ? `${c.switch.status} ${JSON.stringify(c.providers)}` : '',
    attack: r.attack ? (r.attack.match(/(\d+\/\d+) passed/) || [, r.serverExit ? 'server died' : '?'])[1] : '',
    serverDied: !!r.serverExit,
    uncaught: r.uncaughtExceptions,
  });
}
console.table(rows);
fs.writeFileSync(path.join(__dirname, 'results', `${profile}-summary.json`), JSON.stringify(rows, null, 2));
