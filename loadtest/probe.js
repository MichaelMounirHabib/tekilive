/**
 * Preloaded into the server under test (`node -r ./loadtest/probe.js server.js`)
 * to sample its own health without editing server.js. Writes one CSV row
 * every PROBE_INTERVAL_MS to PROBE_OUT:
 *   time, event-loop delay p50/p99/max (ms), event-loop utilization %, CPU % of one core,
 *   RSS MB, heap used MB
 *
 * On Windows the delay histogram has a floor of about 15.6 ms (timer granularity),
 * so utilization (share of wall time the loop was busy) is the steadier load signal.
 */

const fs = require('fs');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

const OUT = process.env.PROBE_OUT;
const INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS || 5000);

if (OUT) {
  fs.writeFileSync(OUT, 'time,loop_p50_ms,loop_p99_ms,loop_max_ms,elu_pct,cpu_pct,rss_mb,heap_mb\n');
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let lastCpu = process.cpuUsage();
  let lastElu = performance.eventLoopUtilization();
  let lastAt = process.hrtime.bigint();

  setInterval(() => {
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(lastCpu);
    const wallUs = Number(now - lastAt) / 1000;
    const mem = process.memoryUsage();
    const elu = performance.eventLoopUtilization(lastElu);
    const row = [
      new Date().toISOString(),
      (loop.percentile(50) / 1e6).toFixed(2),
      (loop.percentile(99) / 1e6).toFixed(2),
      (loop.max / 1e6).toFixed(2),
      (elu.utilization * 100).toFixed(1),
      (((cpu.user + cpu.system) / wallUs) * 100).toFixed(1),
      (mem.rss / 1048576).toFixed(1),
      (mem.heapUsed / 1048576).toFixed(1),
    ];
    fs.appendFileSync(OUT, row.join(',') + '\n');
    loop.reset();
    lastCpu = process.cpuUsage();
    lastElu = performance.eventLoopUtilization();
    lastAt = now;
  }, INTERVAL_MS).unref();
}
