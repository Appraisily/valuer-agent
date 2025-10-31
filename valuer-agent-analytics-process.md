# Valuer Agent Analytics Process

> Internal reference for operators and developers working on the Valuer Agent service (`repos/services/valuer-agent`). This outlines how inbound appraisal requests flow through the pipeline, the components involved, and the controls that keep the analysis deterministic and auditable.

## Purpose
Valuer Agent sits between upstream intake (CRM, landing flows, admin tooling) and the Valuer search backend. It:
- Converts free-form descriptions into structured search plans.
- Queries Valuer for comparable auction data using progressively broader queries.
- Normalises, deduplicates, and scores the resulting market data.
- Runs statistical and narrative analysis to produce the valuation package that downstream channels render.

## Request Flow
| Endpoint | Purpose | Key Inputs | Primary Outputs |
| --- | --- | --- | --- |
| `POST /api/enhanced-statistics` | Full valuation pipeline | `text`, `value`, optional `limit`, `targetCount`, `minPrice`, `maxPrice` | Price summary, histogram buckets, price history, comparable lots, AI justification |
| `POST /api/find-value` | Quick estimate using Valuer multi-search | `text`, optional `useAccurateModel` | Median price + summary |
| `POST /api/auction-results` | Fetch comparable lots for a single keyword | `keyword`, optional `minPrice`, `limit` | Raw lot list + summary statistics |
| `GET /health` | Liveness check | — | `{ status: "ok" }` |

`server.ts` wires these routes, initialises dependencies (`initializeOpenAI`) and manages structured logging, archiving, and optional RabbitMQ events.

## Pipeline Stages

### 1. Keyword Extraction
- `KeywordExtractionService.extractKeywords` (OpenAI-backed) ingests the description and generates 25 search phrases grouped by specificity.
- Prompts enforce auction terminology; a deterministic fallback keeps the pipeline operating if OpenAI fails.
- Output is transformed into a multi-level query pyramid (`buildQueryPyramid`, `flattenPyramid`) with groups: very specific → specific → moderate → broad → very broad.

### 2. Search Plan & Constraints
- `EnhancedStatisticsRequestSchema` (Zod) validates payload shape.
- Target value, optional price bounds, and `targetCount` shape the downstream search budget.
- Default price window spans roughly ±40% around the target value when callers omit overrides.
- Retry and timeout controls live in `ValuerService.fetchWithRetry`; override via `VALUER_RETRY_*` and `VALUER_HTTP_TIMEOUT_MS`.

### 3. Market Data Acquisition
- `MarketDataAggregatorService.gatherAuctionDataProgressively` walks query levels, calling `MarketDataService.searchMarketData`, which delegates to `ValuerService.multiSearch`.
- The aggregator deduplicates by auction house + lot number, tracks counts per keyword, and stops only after it hits the requested volume or exhausts query levels.
- Auth cookies (`VALUER_COOKIES`, `INVALUABLE_*`) and Valuer endpoint (`VALUER_BASE_URL`) are supplied by the runtime env.

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
| `VALUER_BASE_URL` | Base URL for Valuer batch API (`/api/search`) | `http://valuer:8080/api/search` |
| `VALUER_ID_TOKEN` | Pre-issued token when metadata server isn’t available | empty |
| `VALUER_COOKIES` / `INVALUABLE_*` | JSON payload or discrete cookies for upstream auction sources | empty |
| `VALUER_RETRY_ATTEMPTS` / `VALUER_RETRY_BASE_MS` / `VALUER_RETRY_MAX_MS` | Override retry strategy in `ValuerService` | `2`, `500`, `3000` |
| `VALUER_HTTP_TIMEOUT_MS` | Request timeout for Valuer HTTP calls | `90000` |
| `VALUER_ARCHIVE_RESPONSES` | `"true"` archives payloads to storage via `archiveJSON` | `false` |
| `VALUER_ARCHIVE_PREFIX` | Location prefix for archived bundles | `valuer-agent/responses` |
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
- **OpenAI failures** – Keyword extraction and justification fall back to deterministic logic; responses include warnings so UI can downgrade gracefully.
- **Valuer backend unavailable** – Retries exhaust, returning `502`/`504`. Check the Valuer service (`repos/services/valuer`) and the internal registry image tag.
- **Insufficient comparables** – Aggregator returns whatever it found; statistics flag low-sample scenarios so downstream consumers can show caution states.
- **Archiving or messaging issues** – Logged as warnings only. Investigate storage mounts (`LOCAL_STORAGE_ROOT`) or RabbitMQ connectivity separately.

Use this document when onboarding teammates, reviewing incidents, or planning changes—the sections above map directly to the modules in `src/services/` and summarise the knobs that operators rely on in production.
