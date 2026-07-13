#!/usr/bin/env node

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function numberArg(name, fallback) {
  const raw = argValue(name) ?? process.env[name.replace(/^--/, '').replace(/-/g, '_').toUpperCase()];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const baseUrl = (
  argValue('--base') ||
  process.env.BASE_URL ||
  process.env.VALUER_BRIDGE_BASE_URL ||
  'http://127.0.0.1:8113'
).replace(/\/+$/, '');
const timeoutMs = numberArg('--timeout-ms', Number(process.env.SMOKE_TIMEOUT_MS || 45_000));
const attempts = Math.max(1, Math.floor(numberArg('--attempts', Number(process.env.SMOKE_ATTEMPTS || 1))));

function fail(message, details) {
  console.error(`[smoke] FAIL: ${message}`);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

function assert(condition, message, details) {
  if (!condition) fail(message, details);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const requestTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Number(options.timeoutMs)
    : timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`timeout_after_${requestTimeoutMs}ms`)), requestTimeoutMs);
  try {
    const { timeoutMs: _ignoredTimeout, ...fetchOptions } = options;
    const res = await fetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text for diagnostics.
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(path = '/ready') {
  const healthTimeoutMs = Math.min(timeoutMs, 5_000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const health = await request(path, { timeoutMs: healthTimeoutMs });
      if (health.ok) return health;
      lastError = health;
    } catch (err) {
      lastError = err;
    }

    if (attempt < attempts) {
      const detail = lastError instanceof Error ? lastError.message : `status_${lastError?.status || 'unknown'}`;
      console.warn(`[smoke] health attempt ${attempt}/${attempts} not ready: ${detail}`);
      await sleep(1_000);
    }
  }

  if (lastError instanceof Error) {
    fail(`${path} should return 2xx`, lastError.message);
  }
  fail(`${path} should return 2xx`, lastError);
}

function bodyContainsForbiddenProvider(json) {
  const raw = JSON.stringify(json || {});
  return /"provider"\s*:\s*"(live|auto)"/i.test(raw) || /falling back to live provider/i.test(raw);
}

const batchPayload = {
  schemaVersion: '2.0',
  context: {
    target: 'screener',
    rev: 'valuer-bridge-smoke',
  },
  pricing: {
    min: 100,
    max: 20_000,
    reference: 2_500,
    justify: false,
  },
  limits: {
    perTerm: 3,
    total: 1,
    timeoutMs,
    retries: 1,
  },
  options: {
    concurrency: 1,
    sort: 'relevance',
  },
  terms: {
    very_specific: ['Chihuly Macchia bowl'],
    flattened: ['Chihuly Macchia bowl'],
  },
};

console.log(`[smoke] baseUrl=${baseUrl}`);

const live = await request('/live', { timeoutMs: Math.min(timeoutMs, 5_000) });
assert(live.ok, '/live should return 2xx', live);
assert(live.json?.status === 'ok', '/live should report status ok', live.json);
assert(live.json?.service === 'valuer-bridge', '/live should identify valuer-bridge', live.json);
console.log('[smoke] live ok');

const health = await request('/health', { timeoutMs: Math.min(timeoutMs, 5_000) });
assert(health.ok, '/health should return 2xx', health);
assert(health.json?.status === 'ok', '/health should report status ok', health.json);
assert(health.json?.service === 'valuer-bridge', '/health should identify valuer-bridge', health.json);
assert(health.json?.provider === 'auction_data_api', '/health should report auction_data_api provider', health.json);
assert(health.json?.apiConfigured === true, '/health should report apiConfigured=true', health.json);
assert(health.json?.readinessEndpoint === '/ready', '/health should point to /ready', health.json);
console.log('[smoke] health ok');

const ready = await waitForHealth('/ready');
assert(ready.json?.status === 'ok', '/ready should report status ok', ready.json);
assert(ready.json?.service === 'valuer-bridge', '/ready should identify valuer-bridge', ready.json);
assert(ready.json?.provider === 'auction_data_api', '/ready should report auction_data_api provider', ready.json);
assert(ready.json?.apiConfigured === true, '/ready should report apiConfigured=true', ready.json);
assert(ready.json?.upstream?.ready === true, '/ready should confirm upstream readiness', ready.json);
console.log('[smoke] readiness ok');

const batch = await request('/v2/search/batch', {
  method: 'POST',
  body: JSON.stringify(batchPayload),
});
assert(batch.ok, '/v2/search/batch should return 2xx', batch);
assert(batch.json?.success === true, '/v2/search/batch should succeed', batch.json);
assert(Number(batch.json?.batch?.failed || 0) === 0, '/v2/search/batch should have no failed search segments', batch.json?.batch);
assert(Number(batch.json?.summary?.totalItems || 0) > 0, '/v2/search/batch should return at least one lot', batch.json?.summary);
assert(!bodyContainsForbiddenProvider(batch.json), '/v2/search/batch should not expose live/auto provider behavior', batch.json);
console.log(`[smoke] v2 batch ok (${batch.json.summary.totalItems} items)`);

const missingTerms = await request('/v2/search/batch', {
  method: 'POST',
  body: JSON.stringify({
    schemaVersion: '2.0',
    terms: {},
  }),
});
assert(missingTerms.status === 400, '/v2/search/batch missing terms should return 400', missingTerms);
assert(missingTerms.json?.error === 'terms_required', '/v2/search/batch missing terms should return terms_required', missingTerms.json);
console.log('[smoke] missing-terms negative check ok');

for (const endpoint of [
  '/api/justify',
  '/api/find-value',
  '/api/find-value-range',
  '/api/auction-results',
  '/api/wp2hugo-auction-results',
  '/api/multi-search',
  '/api/enhanced-statistics',
]) {
  const removed = await request(endpoint, {
    method: 'POST',
    body: JSON.stringify({ terms: ['Chihuly Macchia bowl'], keyword: 'Chihuly Macchia bowl' }),
  });
  assert(removed.status === 410, `${endpoint} should return 410`, removed);
  assert(removed.json?.error === 'endpoint_removed', `${endpoint} should return endpoint_removed`, removed.json);
}
console.log('[smoke] removed endpoint checks ok');

console.log('[smoke] PASS');
