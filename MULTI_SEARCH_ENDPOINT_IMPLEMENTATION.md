### Multi-search endpoint and single-browser/multi-tab workflow (valuer-agent + valuer)

Note: In current production deployment, valuer-agent requires caller-provided `terms[]` and does not generate search terms. The design below documents the generic capability and historical approach; upstream services (e.g., appraisals-web-services) now own term generation and tiering.

This document proposes a minimal-change implementation to reduce request bursts and browser churn by introducing:

- A batch/multi-search endpoint on `valuer` that executes multiple queries using a single browser instance with multiple tabs and bounded concurrency.
- A corresponding `valuer-agent` endpoint that generates N candidate search terms and delegates to `valuer` in one call.

The goal is to prevent overloading upstream sites and eliminate errors observed in logs such as “Navigating frame was detached”, “Protocol error: Connection closed”, and `net::ERR_ABORTED`, which are consistent with concurrent reuse of a single tab and repeated browser lifecycles.

---

## Observed issues and constraints

- `valuer` currently keeps one browser instance but the search handler creates a tab named `search` for every request and closes it at the end. Concurrent requests can collide on the same tab name, causing detach/abort errors.
- Multiple sequential calls from upstream services (e.g., several queries per appraisal) can spawn many concurrent `/api/search` requests.
- We need to cap parallelism and reuse a single browser instance across related searches to reduce Cloudflare exposure and resource usage.

---

## Design overview

- **Single browser, multi-tab:** Reuse the existing `BrowserManager` (already supports multiple pages via `createTab(name)`) to run several searches concurrently with a configurable concurrency limit. One tab per search query, unique tab names.
- **Batch endpoint on valuer:** Add `POST /api/search/batch` that accepts an array of query parameter objects and optional cookies/settings. The route initializes one `InvaluableScraper`, fans out searches with a concurrency limiter, and aggregates standardized results.
- **Multi-search endpoint on valuer-agent:** Add `POST /api/multi-search`. The agent generates K candidate queries (configurable) using existing `keyword-extraction` utilities, then calls `valuer`’s batch endpoint once. The agent merges and ranks results for downstream consumers.
- **Back-pressure:** Concurrency limited by config (e.g., 2–4 tabs), with a simple in-process queue. Each request within a batch gets a unique tab name and isolated interception.
- **Cookie reuse:** Capture updated cookies from the first successful search and reuse them for subsequent tabs in the same batch.

---

## API changes

### valuer: Batch search endpoint

- Route: `POST /api/search/batch`
- Body:
```json
{
  "searches": [
    { "query": "modernist female figure pastel palette", "priceResult[min]": 1000, "limit": 100, "sort": "relevance" },
    { "query": "flat color figurative woman poster", "priceResult[min]": 1000, "limit": 100, "sort": "relevance" }
  ],
  "cookies": [ { "name": "AZTOKEN-PROD", "value": "...", "domain": ".invaluable.com" } ],
  "fetchAllPages": false,
  "maxPages": 3,
  "concurrency": 3,
  "saveToGcs": false
}
```

- Response (example shape; standardized per existing formatter):
```json
{
  "success": true,
  "timestamp": "2025-08-15T08:44:05.000Z",
  "parameters": { "concurrency": 3, "fetchAllPages": "false", "maxPages": 3 },
  "batch": {
    "total": 2,
    "completed": 2,
    "failed": 0,
    "durationMs": 2310
  },
  "searches": [
    {
      "query": "modernist female figure pastel palette",
      "result": {
        "pagination": { "totalItems": 3456, "totalPages": 36, "itemsPerPage": 96, "currentPage": 1 },
        "data": { "lots": [ /* standardized lots */ ], "totalResults": 96 }
      }
    },
    {
      "query": "flat color figurative woman poster",
      "result": { "pagination": { /* ... */ }, "data": { "lots": [ /* ... */ ] } }
    }
  ]
}
```

Notes:
- Preserve the existing `GET /api/search` behavior unchanged for backward compatibility.
- Each individual search inside the batch is formatted using the same `formatSearchResults` and `standardizeResponse` logic already present in `valuer/src/routes/search.js`.

### valuer-agent: Multi-search endpoint

- Route: `POST /api/multi-search`
- Body:
```json
{
  "description": "Minimalist figurative woman in lavender dress, flat colors",
  "minPrice": 1000,
  "maxQueries": 5,
  "concurrency": 3,
  "limitPerQuery": 100,
  "sort": "relevance"
}
```

- Behavior:
  - Generate up to `maxQueries` candidate phrases using `keyword-extraction` and/or quick LLM-backed paraphrasing with guardrails.
  - Call `valuer` `POST /api/search/batch` with the set of queries and the provided constraints.
  - Merge, deduplicate (by lot ID/url), optionally score by relevance against the `description`, and return a consolidated result set.

- Response (example):
```json
{
  "success": true,
  "generatedQueries": ["modernist female figure pastel palette", "flat color figurative woman poster", "silkscreen style flat color figure"],
  "sources": { "valuerBatchUrl": "https://valuer.../api/search/batch" },
  "data": {
    "lots": [ /* merged + deduped lots */ ],
    "byQuery": { /* per-query standardized results for traceability */ }
  },
  "stats": { "uniqueLots": 184, "queries": 3, "durationMs": 2450 }
}
```

---

## valuer implementation details

Key files to minimally extend:
- `valuer/src/scrapers/invaluable/browser.js`
- `valuer/src/scrapers/invaluable/search-handler.js`
- `valuer/src/routes/search.js`

### 1) Unique tab per search

- Add a utility to generate unique tab names per search: `search-${Date.now()}-${Math.random().toString(36).slice(2,8)}`.
- Update `handleSearch(browser, url, params, cookies, config)` to accept an optional `tabName` and use `browser.createTab(tabName)` instead of the fixed `'search'`.
- Ensure the tab is closed in `finally` via `browser.closeTab(tabName)`.

Pseudo-diff (illustrative):
```js
// search-handler.js
async function handleSearch(browser, url, params = {}, cookies = [], config = {}, tabName) {
  const name = tabName || `search-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const page = await browser.createTab(name);
  try {
    // ... existing logic ...
  } finally {
    await browser.closeTab(name);
  }
}
```

### 2) Concurrency limiter for batch

- In `valuer/src/routes/search.js`, add `POST /api/search/batch`.
- Use a simple semaphore to cap concurrent tabs to `concurrency` (default from env, e.g., 3).
- For each search item:
  - Build the params object (inherit shared filters like `priceResult[min]`).
  - Call `invaluableScraper.search(params, cookies)` passing a unique `tabName` through to the handler.
  - Standardize the result via existing `formatSearchResults`/`standardizeResponse`.
- Aggregate per-search results and summary stats.

### 3) Cookie reuse within a batch

- After the first successful search returns with `cookies` on the catResults payload, merge these into the cookie set and pass to subsequent tabs within the same batch.
- Keep domain scoping and names consistent (`AZTOKEN-PROD`, `cf_clearance`).

### 4) Cloudflare handling and retries

- Retain `browser.handleProtection()` calls in each tab’s navigation.
- On recoverable errors (`net::ERR_ABORTED`, `Protocol error: Connection closed`, navigation timeout):
  - Retry up to 2 times with small randomized backoff per tab.
  - If still failing, mark the sub-search as failed, continue others, and include the error in the batch response.

### 5) Configuration

Environment variables (Cloud Run runtime vars):
- `BATCH_SEARCH_CONCURRENCY` (default 3)
- `NAVIGATION_TIMEOUT_MS` (default 30000)
- `MAX_TABS_PER_PROCESS` (soft cap; default 6–8)

All secrets stay in Secret Manager; no `.env` in production.

---

## valuer-agent implementation details

Key files to minimally extend:
- `valuer-agent/src/services/keyword-extraction.service.ts`
- `valuer-agent/src/services/valuer.ts`
- `valuer-agent/src/server.ts`

### 1) Candidate query generation

- Given a short description/context, generate up to `maxQueries` normalized search strings with a mix of stylistic descriptors and medium qualifiers.
- Use existing `keyword-extraction` utilities; avoid adding new models unless necessary.

### 2) New endpoint `POST /api/multi-search`

- Validate input; default `maxQueries=5`, `minPrice=1000`, `limitPerQuery=100`, `concurrency=3`.
- Build `searches[]` for `valuer` using the generated phrases plus shared filters.
- Call `valuer /api/search/batch` once. Pass through cookies if supplied (optional).
- Merge, dedupe, and score results; return consolidated payload with per-query trace.

### 3) Types and responses

- Add a lightweight type for `MultiSearchResponse` and reuse existing standard result shapes.

### 4) Config

Runtime vars:
- `VALUER_BATCH_ENDPOINT` (e.g., `https://valuer-...run.app/api/search/batch`)
- `VALUER_BATCH_CONCURRENCY` (default 3)
- `VALUER_MIN_PRICE_DEFAULT` (default 1000)

---

## Expected impact

- Fewer internal errors from tab collisions; reduced `Protocol error` and `ERR_ABORTED` incidents.
- Lower overall start/teardown overhead (one browser instance reused) with bounded parallelism.
- Less upstream pressure: one coordinated batch instead of several independent calls.

---

## Rollout plan

1) Implement valuer batch route and unique-tab search support; keep existing endpoints intact.
2) Deploy `valuer` and verify health (`/` and `/api/search`); smoke-test `/api/search/batch` with 2–3 queries.
3) Implement `valuer-agent /api/multi-search`; point to the batch endpoint; deploy.
4) Update upstream caller(s) to use `valuer-agent /api/multi-search` instead of issuing multiple `valuer /api/search` calls.

---

## Test plan

- Unit: concurrency limiter, tab name uniqueness, cookie merge logic, error classification.
- Integration:
  - Batch of 3 queries, concurrency=2: verify two tabs open, then third starts after a tab closes.
  - Induce one query failure; ensure others succeed and batch response reports per-query errors without 500-ing the whole batch.
  - Confirm pagination metadata preserved in standardized responses.
- E2E: run end-to-end flow that previously triggered `net::ERR_ABORTED`; confirm stability and improved latency.

---

## Minimal code touch points (summary)

- `valuer/src/scrapers/invaluable/search-handler.js`: accept `tabName`, generate unique tab names, always close the specific tab in `finally`.
- `valuer/src/routes/search.js`: add `POST /api/search/batch` with concurrency limiter; reuse existing formatting utilities; reuse single `invaluableScraper` from `app.locals`.
- `valuer-agent/src/server.ts`: add `POST /api/multi-search`; orchestrate candidate term generation and invoke `valuer` batch endpoint once; return merged results.

This plan follows the minimal-change principle and keeps a single source of truth for result formatting within `valuer`.


