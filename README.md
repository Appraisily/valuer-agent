# Valuer Bridge

Valuer Bridge is the bounded comparable-auction search service for Appraisily.

It is intentionally not an agent. It does not generate search terms, call OpenAI, scrape live sites, or fall back to alternate providers at runtime. Callers send explicit search terms. Valuer Bridge calls the authenticated Auction Data API owned by Scraper Orchestrator; it does not connect to scraper PostgreSQL directly.

## Runtime Contract

### `GET /live`

Returns process liveness without depending on Auction Data API availability.

### `GET /ready`

Returns HTTP 200 only when the authenticated Auction Data API health check succeeds. It returns HTTP 503 with a bounded upstream diagnostic when the dependency is unavailable.

### `GET /health`

Compatibility health surface. It reports the configured provider and points callers to `/ready`; use `/live` for liveness and `/ready` for dependency readiness.

```json
{
  "status": "ok",
  "service": "valuer-bridge",
  "provider": "auction_data_api",
  "apiConfigured": true,
  "readinessEndpoint": "/ready"
}
```

### `POST /v2/search/batch`

Canonical search endpoint. It accepts caller-owned term tiers and returns per-query lots plus a deduped compact lot list.

```json
{
  "schemaVersion": "2.0",
  "context": {
    "target": "screener",
    "rev": "appraisily-pro-mcp"
  },
  "pricing": {
    "min": 250,
    "max": 20000,
    "reference": 2500,
    "justify": false
  },
  "limits": {
    "perTerm": 20,
    "timeoutMs": 45000,
    "retries": 1
  },
  "options": {
    "concurrency": 3,
    "sort": "relevance"
  },
  "terms": {
    "very_specific": ["Chihuly Macchia bowl"],
    "specific": ["Chihuly art glass bowl"],
    "moderate": ["studio glass bowl"],
    "flattened": ["Chihuly Macchia bowl", "Chihuly art glass bowl", "studio glass bowl"]
  }
}
```

Important behavior:

- `terms` must contain at least one non-empty term.
- The service never creates terms from `description` or image data.
- `pricing.min` defaults to `VALUER_MIN_PRICE_DEFAULT` or `250`.
- `limits.perTerm` is capped at `200`.
- `options.concurrency` is capped at `10`.
- The provider is always `auction_data_api`.
- `limits.timeoutMs` is one absolute batch deadline, capped at 120 seconds. Every attempt receives only the remaining budget.
- `limits.retries` is capped at three retries; validation errors and successful empty searches are never retried.
- Partial batches return `diagnostics.partial=true` and per-term failure codes, so callers can distinguish an upstream timeout from a true zero-result search.
- A transport circuit breaker stops repeated attempts while the Auction Data API is unhealthy.
- `data.lots` and every `data.byQuery[].result.data.lots[]` entry use the canonical auction lot fields: `schemaVersion`, `lotUid`, `lotRef`, `title`, `description`, `houseName`, `saleType`, `auctionDate`, `priceRealised`, `currency`, `estimateMin`, `estimateMax`, `lotNumber`, `sourceUrl`, `rankingScore`, `assetStatus`, `assetVerifiedAt`, and `imageUrl`.
- `imageUrl` is non-null only when the upstream contract says `assetStatus=available` and includes a verification timestamp.

## Removed Endpoints

The old valuation and compatibility routes now return `410 endpoint_removed` with `replacement: "/v2/search/batch"`:

- `POST /api/justify`
- `POST /api/find-value`
- `POST /api/find-value-range`
- `POST /api/auction-results`
- `POST /api/wp2hugo-auction-results`
- `POST /api/multi-search`
- `POST /api/enhanced-statistics`

## Environment

Required:

- `AUCTION_DATA_API_URL`
- `AUCTION_DATA_API_KEY`

Optional:

- `PORT`
- `CORS_ALLOWED_ORIGINS`
- `AUCTION_DATA_API_TIMEOUT_MS`
- `VALUER_READINESS_TIMEOUT_MS`
- `AUCTION_DATA_API_CIRCUIT_FAILURES`
- `AUCTION_DATA_API_CIRCUIT_COOLDOWN_MS`
- `VALUER_CONCURRENCY`
- `VALUER_BATCH_CONCURRENCY`
- `VALUER_BATCH_HTTP_TIMEOUT_MS`
- `VALUER_MIN_PRICE_DEFAULT`
- `SCRAPPER_INTERNAL_API_KEY`
- `SCRAPPER_THUMBS_PUBLISH_URL`
- `SCRAPPER_THUMBS_PUBLISH_CONCURRENCY`
- `SCRAPPER_THUMBS_PUBLISH_TIMEOUT_MS`
- `VALUER_PUBLISH_THUMBS_DISABLED`
- `VALUER_PUBLISH_THUMBS_LIMIT`
- `LOCAL_STORAGE_*`, `PUBLIC_ASSETS_BASE_URL`, `PUBLIC_STORAGE_ROOT`
- `MESSAGE_*`
- `VALUER_ARCHIVE_RESPONSES`, `VALUER_ARCHIVE_PREFIX`

Temporary environment aliases retained for one compatibility release:

- `SCRAPER_DB_CONCURRENCY` → `VALUER_CONCURRENCY`
- `SCRAPER_DB_PUBLISH_THUMBS_DISABLED` → `VALUER_PUBLISH_THUMBS_DISABLED`
- `SCRAPER_DB_PUBLISH_THUMBS_LIMIT` → `VALUER_PUBLISH_THUMBS_LIMIT`

Canonical settings take precedence when both names are present. A legacy-only setting emits a deprecation warning and remains functional until the dated removal follow-up after the first compatibility release.

## Checks

```bash
npm run test
npm run lint
npm run build
VALUER_BRIDGE_BASE_URL=http://127.0.0.1:8113 npm run smoke
```

Deploy smoke:

```bash
npm run smoke:deploy -- --base https://valuer-bridge.appraisily.com --container valuer-bridge
```

The deploy smoke is wired into the VPS deploy helper. Candidate deploys run the HTTP contract against the temporary container before promotion. Live deploys additionally assert the container runtime env has `AUCTION_DATA_API_URL` and `AUCTION_DATA_API_KEY`, does not have legacy AI/fallback provider env names, and has no recent blocking log errors.

For runtime env schema validation:

```bash
ENV_GOV_ENV_FILE=/srv/infrastructure/vps-infra/compose/appraisily/runtime/docker-compose/valuer-bridge/runtime.env npm run env:check
```
