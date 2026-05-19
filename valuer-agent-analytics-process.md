# Valuer Bridge Analytics Process

> Internal reference for operators and developers working on the Valuer Bridge service (`repos/services/valuer-agent`). The repo path remains legacy for source-control continuity, but runtime-facing names should use `valuer-bridge`; `valuer-agent` is a temporary compatibility alias only.

## Purpose
Valuer Bridge sits between upstream intake (CRM, landing flows, admin tooling) and Appraisily's scraper database. It:
- Accepts caller-owned search plans for batch endpoints.
- Queries scraper DB records for comparable auction data.
- Normalises, deduplicates, and scores the resulting market data.
- Runs statistical and narrative analysis to produce the valuation package that downstream channels render.

## Request Flow
| Endpoint | Purpose | Key Inputs | Primary Outputs |
| --- | --- | --- | --- |
| `POST /api/enhanced-statistics` | Full valuation pipeline | `text`, `value`, optional `limit`, `targetCount`, `minPrice`, `maxPrice` | Price summary, histogram buckets, price history, comparable lots, AI justification |
| `POST /api/find-value` | Quick estimate using Valuer multi-search | `text`, optional `useAccurateModel` | Median price + summary |
| `POST /api/auction-results` | Fetch comparable lots for a single keyword | `keyword`, optional `minPrice`, `limit` | Raw lot list + summary statistics |
| `GET /health` | Liveness/readiness check | — | `{ status: "ok", service: "valuer-bridge", provider: "scraper_db", dbConfigured: true }` |

`server.ts` wires these routes, initialises dependencies (`initializeOpenAI`) and manages structured logging, archiving, and optional RabbitMQ events.

## Pipeline Stages

### 1. Search Term Ownership
- `/v2/search/batch` and `/api/multi-search` require explicit caller-provided terms.
- Upstream callers own term planning and tiering; Valuer Bridge executes and normalizes the DB-backed search plan.
- Historical keyword-extraction helpers may still support older analytical routes, but they must not be used as a missing-term fallback for the batch endpoints.

### 2. Search Plan & Constraints
- `EnhancedStatisticsRequestSchema` (Zod) validates payload shape.
- Target value, optional price bounds, and `targetCount` shape the downstream search budget.
- Default price window spans roughly ±40% around the target value when callers omit overrides.
- Batch size and timeout controls live in `VALUER_BATCH_CONCURRENCY`, `VALUER_BATCH_HTTP_TIMEOUT_MS`, and request-level limits.

### 3. Market Data Acquisition
- `MarketDataAggregatorService.gatherAuctionDataProgressively` walks query levels, calling `MarketDataService.searchMarketData`, which delegates to `ValuerService.multiSearch`.
- The aggregator deduplicates by auction house + lot number, tracks counts per keyword, and stops only after it hits the requested volume or exhausts query levels.
- `ValuerService` uses `ScraperDbClient` for all auction searches. No provider selection, live scraping, external Valuer endpoint, or Invaluable cookie auth is supported in this service.

### 4. Post-processing & Normalisation
- Results are projected into `SimplifiedAuctionItem` objects containing unified currency data, sale dates, and provenance.
- Items are sorted by proximity to the target value so statistics remain deterministic.
- Optional archiving (`VALUER_ARCHIVE_RESPONSES=true`) persists request/response payloads to mounted storage via `archiveJSON`.

### 5. Statistical Analysis
- `StatisticsService` orchestrates distribution calculations (mean, median, percentiles, volatility) using `StatisticalAnalysisService`.
- `MarketReportService` creates histogram buckets, price history (grouped by year), and trend indicators with fallbacks when metadata is sparse.
- The statistics layer operates exclusively on the filtered set returned by the aggregator—no additional queries are executed at this stage.

### 6. Narrative & Justification
- `JustifierAgent` uses OpenAI to produce market context and confidence notes. It can trigger supplemental Valuer lookups for justification without mutating the canonical statistics set.
- When RabbitMQ is configured (`MESSAGE_BROKER_URL`), `publishEvent` emits a `valuer.http.completed` event containing timing metadata and request identifiers.

### 7. Response Packaging
- The HTTP handler combines statistics, market report artefacts, comparable lots, and generated narratives into the API response.
- Correlated request/response objects (including the incoming body) can be archived to storage or routed via messaging for downstream auditing.
- `closeBroker` flushes RabbitMQ connections during graceful shutdown.

## Key Environment Variables
| Variable | Description | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Required for keyword extraction, statistics, and narrative prompts | — |
| `SCRAPER_DB_URL` / `SCRAPER_DATABASE_URL` | Required Postgres connection string for the scraper database | — |
| `SCRAPER_DB_POOL_SIZE` / `SCRAPER_DB_QUERY_TIMEOUT_MS` / `SCRAPER_DB_CONCURRENCY` | DB pool, statement timeout, and batch concurrency controls | service defaults |
| `VALUER_ARCHIVE_RESPONSES` | `"true"` archives payloads to storage via `archiveJSON` | `false` |
| `VALUER_ARCHIVE_PREFIX` | Location prefix for archived bundles | `valuer-bridge/responses` |
| `MESSAGE_BROKER_URL` / `MESSAGE_ROUTING_KEY` | Enable RabbitMQ event publishing | disabled |
| `LOCAL_STORAGE_ROOT` / `LOCAL_STORAGE_BASE_URL` | Mount + URL for archived artefacts | provided by Compose overlay |

See `.env.example` and the Compose overlay `.env` for the canonical list.

## Operational Notes
- The first request after a deploy initialises OpenAI clients; expect a slight cold start while credentials load.
- HTTP logs are JSON with `request:start` / `request:end` markers and correlation IDs—use them in Loki or `docker logs` during triage.
- Archives land under `/mnt/srv-storage/storage` when enabled; ensure the container mounts the storage volume.
- Add regression coverage in `src/tests/` when altering prompts, statistical logic, or response shapes.
- Coordinate breaking contract changes with downstream consumers (CRM, frontends, admin dashboard) and update shared schemas if required.

## Failure Modes & Recovery
- **OpenAI failures** – Narrative/statistical routes should return explicit errors or degraded summaries depending on the route contract; batch DB search does not depend on OpenAI.
- **Scraper DB unavailable** – Requests fail explicitly. Check DB connectivity, `SCRAPER_DB_URL`, pool limits, and query timeout settings.
- **Insufficient comparables** – Aggregator returns whatever it found; statistics flag low-sample scenarios so downstream consumers can show caution states.
- **Archiving or messaging issues** – Logged as warnings only. Investigate storage mounts (`LOCAL_STORAGE_ROOT`) or RabbitMQ connectivity separately.

Use this document when onboarding teammates, reviewing incidents, or planning changes—the sections above map directly to the modules in `src/services/` and summarise the knobs that operators rely on in production.
