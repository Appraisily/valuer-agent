# Valuer Bridge

Valuer Bridge is the DB-backed comparable-auction search service for Appraisily.

It is intentionally not an agent. It does not generate search terms, call OpenAI, scrape live sites, or fall back to alternate providers at runtime. Callers must send explicit search terms, and the service queries the scraper Postgres database through `ScraperDbClient`.

## Runtime Contract

### `GET /health`

Returns service readiness and the active provider.

```json
{
  "status": "ok",
  "service": "valuer-bridge",
  "provider": "scraper_db",
  "dbConfigured": true
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
- The provider is always `scraper_db`.

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

- `SCRAPER_DB_URL`

Optional:

- `PORT`
- `CORS_ALLOWED_ORIGINS`
- `SCRAPER_DATABASE_URL` / `SCRAPER_DB_CONNECTION_STRING` as scraper DB connection-string aliases
- `SCRAPER_DB_SSL`
- `SCRAPER_DB_POOL_SIZE`
- `SCRAPER_DB_QUERY_TIMEOUT_MS`
- `SCRAPER_DB_CONCURRENCY`
- `VALUER_BATCH_CONCURRENCY`
- `VALUER_BATCH_HTTP_TIMEOUT_MS`
- `VALUER_MIN_PRICE_DEFAULT`
- `SCRAPPER_INTERNAL_API_KEY`
- `SCRAPPER_THUMBS_PUBLISH_URL`
- `SCRAPPER_THUMBS_PUBLISH_CONCURRENCY`
- `SCRAPPER_THUMBS_PUBLISH_TIMEOUT_MS`
- `SCRAPER_DB_PUBLISH_THUMBS_DISABLED`
- `SCRAPER_DB_PUBLISH_THUMBS_LIMIT`
- `LOCAL_STORAGE_*`, `PUBLIC_ASSETS_BASE_URL`, `PUBLIC_STORAGE_ROOT`
- `MESSAGE_*`
- `VALUER_ARCHIVE_RESPONSES`, `VALUER_ARCHIVE_PREFIX`

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

The deploy smoke is wired into the VPS deploy helper. Candidate deploys run the HTTP contract against the temporary container before promotion. Live deploys additionally assert the container runtime env has `SCRAPER_DB_URL`, does not have legacy/AI/fallback env names, and has no recent blocking log errors.

For runtime env schema validation:

```bash
ENV_GOV_ENV_FILE=/srv/infrastructure/vps-infra/compose/appraisily/runtime/docker-compose/valuer-agent/runtime.env npm run env:check
```
