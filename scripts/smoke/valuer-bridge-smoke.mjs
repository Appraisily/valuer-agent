#!/usr/bin/env node

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

const baseUrl = (
  argValue('--base') ||
  process.env.BASE_URL ||
  process.env.VALUER_BRIDGE_BASE_URL ||
  'http://127.0.0.1:8113'
).replace(/\/+$/, '');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 45_000);

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

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`timeout_after_${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
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

const multiSearchPayload = {
  description: 'Dale Chihuly Macchia blown glass bowl',
  terms: ['Chihuly Macchia bowl'],
  minPrice: 100,
  maxPrice: 20_000,
  limitPerQuery: 3,
  concurrency: 1,
  skipSummary: true,
  maxItems: 3,
};

console.log(`[smoke] baseUrl=${baseUrl}`);

const health = await request('/health');
assert(health.ok, '/health should return 2xx', health);
assert(health.json?.status === 'ok', '/health should report status ok', health.json);
assert(health.json?.service === 'valuer-bridge', '/health should identify valuer-bridge', health.json);
assert(health.json?.provider === 'scraper_db', '/health should report scraper_db provider', health.json);
assert(health.json?.dbConfigured === true, '/health should report dbConfigured=true', health.json);
console.log('[smoke] health ok');

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

const multi = await request('/api/multi-search', {
  method: 'POST',
  body: JSON.stringify(multiSearchPayload),
});
assert(multi.ok, '/api/multi-search should return 2xx', multi);
assert(multi.json?.success === true, '/api/multi-search should succeed', multi.json);
assert(Number(multi.json?.stats?.totalLots || 0) > 0, '/api/multi-search should return at least one lot', multi.json?.stats);
assert(!bodyContainsForbiddenProvider(multi.json), '/api/multi-search should not expose live/auto provider behavior', multi.json);
console.log(`[smoke] multi-search ok (${multi.json.stats.totalLots} lots)`);

const missingTerms = await request('/api/multi-search', {
  method: 'POST',
  body: JSON.stringify({ description: 'Dale Chihuly Macchia blown glass bowl', terms: [] }),
});
assert(missingTerms.status === 400, '/api/multi-search missing terms should return 400', missingTerms);
assert(missingTerms.json?.error === 'terms_required', '/api/multi-search missing terms should return terms_required', missingTerms.json);
console.log('[smoke] missing-terms negative check ok');

console.log('[smoke] PASS');
