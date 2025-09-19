# Valuer Agent Backend

A Node.js/Express backend service for antique and collectible item valuation and analysis, leveraging OpenAI language models and auction database integration.

## Overview

The Valuer Agent Backend provides API endpoints for item valuation, price justification, value range analysis, auction result searches, and enhanced statistical analysis for antiques and collectibles. It connects to an auction database service and uses AI models to analyze and interpret market data.

## Core Technologies

- **Node.js/Express**: Backend framework
- **TypeScript**: Type-safe JavaScript
- **OpenAI API**: For AI-powered valuation and analysis
- **Google Cloud Secret Manager**: For secure API key management
- **Docker**: For containerization and deployment

## Installation and Setup

```bash
# Clone the repository
git clone <repository-url>

# Install dependencies
npm install

# Development mode
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Environment Requirements

The application requires the following environment variables:

- `GOOGLE_CLOUD_PROJECT_ID`: Google Cloud project ID for Secret Manager
- `PORT`: (Optional) Server port, defaults to 8080

Optional (to improve auction search reliability via Valuer service):

- `INVALUABLE_AZTOKEN_PROD` or `AZTOKEN_PROD`: Invaluable session token
- `INVALUABLE_CF_CLEARANCE` (and/or `CF_CLEARANCE`): Cloudflare clearance cookie value
- `VALUER_COOKIES` or `INVALUABLE_COOKIES`: JSON array of cookie objects to forward to Valuer batch (overrides the above if present)

When present, these values are forwarded to the Valuer API so the underlying scraper can authenticate and avoid empty results.

Secrets are managed through Google Cloud Secret Manager. The primary secret required is:
- `OPENAI_API_KEY`: API key for OpenAI services

## File Structure

```
/
├── dist/                # Compiled output
├── src/
│   ├── server.ts        # Main Express server setup
│   ├── services/        # Core service modules
│   │   ├── justifier-agent.ts      # Valuation justification agent
│   │   ├── keyword-extraction.service.ts # Keyword extraction for searches
│   │   ├── market-data-aggregator.service.ts # Aggregates market data
│   │   ├── market-data.ts          # Market data fetching service
│   │   ├── market-report.service.ts # Market report generation
│   │   ├── statistical-analysis.service.ts # Statistical analysis
│   │   ├── statistics-service.ts   # Enhanced statistics service
│   │   ├── types.ts                # Type definitions
│   │   ├── valuer.ts               # Core valuation service
│   │   ├── prompts/               # AI prompts
│   │   └── utils/                 # Utility functions
│   ├── tests/           # Test files
├── Dockerfile           # Docker configuration
├── tsconfig.json        # TypeScript configuration
└── package.json         # Project dependencies and scripts
```

## Core Classes

### ValuerService

The primary service for interfacing with the auction database API.

**Key Methods:**
- `search(query: string, minPrice?: number, maxPrice?: number, limit?: number)`: Searches auction database with filters
- `findValuableResults(keyword: string, minPrice: number, limit: number)`: Finds valuable auction results with refinement logic
- `findSimilarItems(description: string, targetValue?: number)`: Finds items similar to a description

### JustifierAgent

An AI-powered agent for justifying valuations and finding value ranges.

**Key Methods:**
- `justify(text: string, value: number)`: Justifies a valuation against market data
- `findValue(text: string)`: Determines a value for an item based on its description
- `findValueRange(text: string, useAccurateModel: boolean)`: Finds a value range with confidence levels

### StatisticsService

Generates enhanced statistical analysis of market data.

**Key Methods:**
- `generateStatistics(text: string, value: number, targetCount: number, minPrice?: number, maxPrice?: number)`: Creates comprehensive statistical analysis

### MarketDataService

Retrieves and processes market data for analysis.

**Key Methods:**
- `searchMarketData(searchTerms: string[], targetValue?: number, isForJustification?: boolean, minRelevance?: number)`: Executes multiple searches and aggregates results

## API Endpoints

### POST /api/justify [Deprecated]
This endpoint is deprecated. Use `POST /api/multi-search` with `{ justify: true, targetValue }` for combined search + justification and a structured summary.

Justifies a valuation based on item description and proposed value.

**Request Schema:**
```json
{
  "text": "string",
  "value": "number"
}
```

**Response:**
```json
{
  "success": true,
  "explanation": "string",
  "auctionResults": [...],
  "allSearchResults": [...]
}
```

### POST /api/multi-search (with justification)
Performs concurrent term searches. When called with `justify:true` and a `targetValue`, it narrows the price band and returns a `summary` including `{ minValue, maxValue, mostLikelyValue, supportLevel?, comparableItems[] }`.

Notes (current deployment behavior):
- `terms` is required. This service does not generate search terms when `terms` is missing/empty. Upstream callers (e.g., web‑services) own term generation and grouping.
- `description` may be an empty string when `terms` are provided — this is expected.
- Concurrency is honored per batch (typically 3). There is no hard early‑stop by default; you can cap total unique lots with the request field `maxItems` or the env `VALUER_EARLY_STOP_AT` (> 0). If neither is set, the service will collect up to the natural maximum (e.g., queries × per‑query limit).

Example request (preferred):
```json
{
  "description": "",
  "terms": [
    "surrealist color lithograph tents",
    "limited edition lithograph red tents",
    "desert surreal scene print",
    "attenuated figures surreal lithograph",
    "pyramidal tents modern print",
    "European surrealist lithograph"
  ],
  "limitPerQuery": 100,
  "concurrency": 3
}
```

Error response when `terms` missing/empty:
```json
{
  "success": false,
  "error": "terms_required",
  "message": "Provide non-empty terms[]; term generation is disabled in this deployment."
}
```

### POST /v2/search/batch (preferred)
Structured, versioned contract for multi-term search. Caller provides tiered terms and pricing; the service executes batches respecting caller ordering and returns the accepted plan and per-query results.

Request headers:
- `X-Correlation-Id`: optional correlation identifier echoed back
- `Idempotency-Key`: optional key to deduplicate retries

Request body schema (TypeScript/Zod equivalent):
```jsonc
{
  "schemaVersion": "2.0", // optional, defaults "2.0"
  "context": {
    "sessionId": "string?",
    "appraisalId": "string?",
    "target": "professional" | "screener",
    "rev": "string?" // arbitrary caller revision tag
  },
  "pricing": {
    "min": 100,          // WS-owned effective min price
    "max": 2000,         // optional WS-owned effective max price
    "reference": 800,    // optional appraiser reference value (echoed; used in summaries)
    "justify": true      // whether banding is intended
  },
  "limits": {
    "perTerm": 100,      // per-query lot limit
    "total": 21,         // optional total query cap across tiers
    "timeoutMs": 150000, // optional batch timeout
    "retries": 3         // optional retry attempts
  },
  "options": {
    "tierSplit": "provided", // must be "provided"; service won’t re-tier
    "concurrency": 3,
    "sort": "relevance"
  },
  "terms": {
    "very_specific": ["Laszlo De Nagy oil painting", "Truro Lighthouse oil on board"],
    "specific": ["oil on board lighthouse", "coastal dunes oil painting"],
    "moderate": ["oil landscape"],
    "flattened": [/* very_specific + specific + moderate ordered */]
  }
}
```

Response:
```json
{
  "success": true,
  "correlationId": "...",
  "acceptedPlan": { "very_specific": 9, "specific": 9, "moderate": 3, "total": 21 },
  "used": {
    "queries": [ { "term": "...", "tier": "very specific" }, { "term": "...", "tier": "specific" } ],
    "pricing": { "min": 325, "max": 1300, "reference": 800, "justify": true }
  },
  "data": { "byQuery": [ /* per-query results with lots */ ] },
  "batch": { "total": 9, "completed": 9, "failed": 0 },
  "summary": { "totalItems": 468, "uniqueLots": 448, "durationMs": 20817 },
  "meta": { "schemaVersion": "2.0", "context": { /* echoed */ } }
}
```

Notes:
- The service does not alter tier assignment when `terms` are provided. Ordering is preserved.
- Pricing min/max is taken as-is from the request; no implicit banding is applied server-side.
- Exactly one underlying Valuer `/api/search/batch` call is executed per request across all tiers (no per-tier batching).
- Concurrency applies across the combined set of queries (best-effort, capped by `concurrency`).

### POST /api/find-value
Determines a value for an item based on its description.

**Request Schema:**
```json
{
  "text": "string"
}
```

**Response:**
```json
{
  "success": true,
  "value": "number",
  "explanation": "string"
}
```

### POST /api/find-value-range
Finds a value range with confidence levels.

**Request Schema:**
```json
{
  "text": "string",
  "useAccurateModel": "boolean" (optional)
}
```

**Response:**
```json
{
  "success": true,
  "minValue": "number",
  "maxValue": "number",
  "mostLikelyValue": "number",
  "explanation": "string",
  "auctionResults": [...],
  "confidenceLevel": "number",
  "marketTrend": "rising|stable|declining",
  "keyFactors": [...],
  "dataQuality": "high|medium|low"
}
```

### POST /api/auction-results
Retrieves auction results for a keyword.

**Request Schema:**
```json
{
  "keyword": "string",
  "minPrice": "number" (optional),
  "limit": "number" (optional)
}
```

**Response:**
```json
{
  "success": true,
  "keyword": "string",
  "totalResults": "number",
  "minPrice": "number",
  "auctionResults": [...]
}
```

### POST /api/wp2hugo-auction-results
Retrieves auction results in WordPress-Hugo compatible format.

**Request Schema:**
```json
{
  "keyword": "string",
  "minPrice": "number" (optional),
  "limit": "number" (optional)
}
```

**Response:**
```json
{
  "success": true,
  "keyword": "string",
  "totalResults": "number",
  "minPrice": "number",
  "auctionResults": [...],
  "summary": "string",
  "priceRange": {
    "min": "number",
    "max": "number",
    "median": "number"
  },
  "timestamp": "string"
}
```

### POST /api/enhanced-statistics
Generates comprehensive statistical analysis of market data.

**Request Schema:**
```json
{
  "text": "string",
  "value": "number",
  "limit": "number" (optional),
  "targetCount": "number" (optional),
  "minPrice": "number" (optional),
  "maxPrice": "number" (optional)
}
```

**Response:**
```json
{
  "success": true,
  "statistics": {
    "count": "number",
    "average_price": "number",
    "median_price": "number",
    "price_min": "number",
    "price_max": "number",
    "standard_deviation": "number",
    "coefficient_of_variation": "number",
    "percentile": "string",
    "confidence_level": "string",
    "price_trend_percentage": "string",
    "histogram": [...],
    "comparable_sales": [...],
    "value": "number",
    "target_marker_position": "number",
    "total_count": "number",
    "price_history": [...],
    "historical_significance": "number",
    "investment_potential": "number",
    "provenance_strength": "number",
    "data_quality": "string"
  },
  "message": "string"
}
```

## Type Definitions

### AuctionItemWithRelevance
```typescript
interface AuctionItemWithRelevance {
  title: string;
  price: number;
  currency: string;
  house: string;
  date: string;
  description?: string;
  diff?: string;
  is_current?: boolean;
  relevanceScore?: number;
  adjustmentFactor?: number;
  relevanceReason?: string;
}
```

### EnhancedStatistics
```typescript
interface EnhancedStatistics {
  count: number;
  average_price: number;
  median_price: number;
  price_min: number;
  price_max: number;
  standard_deviation: number;
  coefficient_of_variation: number;
  percentile: string;
  confidence_level: string;
  price_trend_percentage: string;
  histogram: HistogramBucket[];
  comparable_sales: FormattedAuctionItem[];
  value: number;
  target_marker_position: number;
  total_count?: number;
  price_history: PriceHistoryPoint[];
  historical_significance: number;
  investment_potential: number;
  provenance_strength: number;
  data_quality?: string;
}
```

### ValueRangeResponse
```typescript
interface ValueRangeResponse {
  minValue: number;
  maxValue: number;
  mostLikelyValue: number;
  explanation: string;
  auctionResults: AuctionItemWithRelevance[];
  confidenceLevel: number;
  marketTrend: 'rising' | 'stable' | 'declining';
  keyFactors?: string[];
  dataQuality?: 'high' | 'medium' | 'low';
}
```

## Processing Flow

1. **API Request Handling**: Express routes receive client requests and validate using Zod schemas
2. **Secret Management**: OpenAI key fetched securely from Google Cloud Secret Manager
3. **Keyword Extraction**: AI extracts optimal search keywords from item descriptions
4. **Market Data Retrieval**: ValuerService fetches auction results based on keywords
5. **Data Analysis**: 
   - JustifierAgent analyzes market data and generates value justifications
   - StatisticsService calculates comprehensive market statistics
6. **Error Handling**: Structured error handling with appropriate HTTP status codes

## Deployment

The application is containerized using Docker and deployed to Google Cloud Run:

1. Build the Docker image: `docker build -t valuer-agent .`
2. Deploy to Cloud Run: `gcloud run deploy valuer-agent --image=valuer-agent`

The Cloud Run service must have access to Secret Manager to retrieve API keys.

## Error Handling

The application uses Express middleware for centralized error handling:
- Zod validation errors return 400 Bad Request
- API errors use appropriate HTTP status codes
- All errors include structured JSON response with error details

## Security

- API Keys are stored in Google Cloud Secret Manager, not in code
- Input validation on all endpoints using Zod schemas
- Express security best practices including proper error handling

## Development Workflow

1. Make changes to TypeScript files in the `src` directory
2. Run tests: `npm test`
3. Build: `npm run build`
4. Deploy: Push to the deployment branch to trigger CI/CD
