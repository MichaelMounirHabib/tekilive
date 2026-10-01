/**
 * Audience analytics. Session state lives in memory and is gone after a
 * restart, so who joined which session is recorded here instead, as custom
 * events in Azure Application Insights (query them in the Azure portal).
 *
 * Sent straight to the ingestion API with the built-in fetch rather than
 * through the Application Insights SDK — a couple of events per attendee
 * don't need a full telemetry stack. Does nothing when
 * APPLICATIONINSIGHTS_CONNECTION_STRING isn't set (e.g. local runs).
 */

const CONNECTION_STRING = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || '';

function parseConnectionString(str) {
  const parts = {};
  str.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) parts[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
  });
  if (!parts.instrumentationkey) return null;
  const endpoint = (parts.ingestionendpoint || 'https://dc.services.visualstudio.com').replace(/\/+$/, '');
  return { iKey: parts.instrumentationkey, trackUrl: `${endpoint}/v2/track` };
}

const config = CONNECTION_STRING ? parseConnectionString(CONNECTION_STRING) : null;

const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE = 1000; // if ingestion is down for a while, drop the oldest rather than grow forever
let queue = [];

function isEnabled() {
  return !!config;
}

/**
 * Queue one custom event. `properties` are strings (session, lang, …),
 * `measurements` are numbers (audience size, seconds connected, …).
 */
function trackEvent(name, { userId, properties = {}, measurements = {} } = {}) {
  if (!config) return;
  const tags = { 'ai.cloud.role': 'tekilive' };
  if (userId) tags['ai.user.id'] = userId;
  queue.push({
    name: 'Microsoft.ApplicationInsights.Event',
    time: new Date().toISOString(),
    iKey: config.iKey,
    tags,
    data: { baseType: 'EventData', baseData: { ver: 2, name, properties, measurements } },
  });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
}

async function flush() {
  if (!config || queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    const res = await fetch(config.trackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) console.warn(`[analytics] ingestion returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    // Network blip: put the batch back and try again on the next flush.
    queue = batch.concat(queue).slice(-MAX_QUEUE);
    console.warn('[analytics] send failed, will retry:', err.message);
  }
}

if (config) {
  setInterval(flush, FLUSH_INTERVAL_MS).unref();
  // App Service sends SIGTERM on restart/redeploy — don't lose the last few seconds.
  process.once('SIGTERM', () => { flush().finally(() => process.exit(0)); });
} else {
  console.warn('[analytics] APPLICATIONINSIGHTS_CONNECTION_STRING not set — audience analytics are disabled.');
}

module.exports = { isEnabled, trackEvent, flush };
