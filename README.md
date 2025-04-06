# AI Valuation Justifier & Statistics Service

An intelligent service that provides detailed justifications and comprehensive statistics for antique and collectible valuations using OpenAI's GPT model and real-time market data.

## Tech Stack

- 🚀 Node.js with Express
- 🔒 Google Cloud Secret Manager for secure API key storage
- 🤖 OpenAI GPT integration (GPT-4o and o3-mini models)
- ✨ TypeScript with strict type safety
- 📊 External Valuer API for Auction Data
- 🧪 Vitest for testing
- 🐳 Docker support

## Features

- **Valuation Justification:** Analyzes if a proposed value is reasonable based on market data.
- **Value Estimation:** Calculates a likely market value for an item.
- **Value Range Analysis:** Provides a likely price range (standard or accurate mode) with confidence levels, market trends, and key factors.
- **Auction Results:** Retrieves relevant auction results based on keywords and filters.
- **Enhanced Market Statistics:** Generates comprehensive statistics including price distribution (histogram), historical price trends, comparable sales analysis, and qualitative scores (historical significance, investment potential, provenance strength).
- **Smart Search Strategies:** Uses AI to generate multi-level search queries for effective market data gathering.
- **Modular Service Architecture:** Core logic is broken down into specialized services for maintainability.
- **Secure API Key Management:** Uses Google Cloud Secret Manager.
- **Asynchronous Operations:** Leverages async/await for non-blocking I/O.
- **Error Handling:** Centralized error handling middleware.

## Project Structure (Post-Refactoring)

```
src/
├── server.ts                      # Express server setup, API routes, middleware
├── services/
│   ├── justifier-agent.ts         # Handles value justification, estimation, and range finding logic
│   ├── keyword-extraction.service.ts # Extracts keywords using AI for searches
│   ├── market-data-aggregator.service.ts # Gathers and aggregates market data progressively
│   ├── market-data.ts             # Processes raw market data (potentially part of aggregator or separate)
│   ├── market-report.service.ts   # Generates histograms, trends, history, comparables
│   ├── statistical-analysis.service.ts # Calculates core stats and qualitative metrics
│   ├── valuer.ts                  # Valuer API client/integration
│   ├── types.ts                   # Shared TypeScript interfaces
│   ├── prompts/                   # AI prompt templates (standard and accurate)
│   │   ├── index.ts
│   │   └── accurate.ts
│   └── utils/
│       ├── openai-helper.ts       # Utility for standardized OpenAI API calls
│       └── tokenizer.ts           # Token management utilities (if still used)
└── tests/                         # Test suites (needs updates post-refactoring)
```

## API Endpoints

All endpoints accept `POST` requests with a JSON body.

### 1. `/api/justify`

Analyzes whether a proposed value for an item description is reasonable based on market data.

**Request Body:**
```json
{
  "text": "<Item Description (string)>",
  "value": <Proposed Value (number)>
}
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "explanation": "<Concise justification text>",
  "auctionResults": [ <Array of SimplifiedAuctionItem> ],
  "allSearchResults": [ <Array of MarketDataResult> ] // Raw results from internal searches
}
```

**Error Response (4xx/5xx):** Standard error format (see Error Handling).

### 2. `/api/find-value`

Estimates a likely market value for a given item description.

**Request Body:**
```json
{
  "text": "<Item Description (string)>"
}
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "value": <Calculated Value (number)>,
  "explanation": "<Explanation text>"
}
```

**Error Response (4xx/5xx):** Standard error format.

### 3. `/api/find-value-range`

Provides a market value range estimation for an item description. Supports standard (broader range) and accurate (narrower range, uses GPT-4o) modes.

**Request Body:**
```json
{
  "text": "<Item Description (string)>",
  "useAccurateModel": <boolean (optional, default: false)>
}
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "minValue": <number>,
  "maxValue": <number>,
  "mostLikelyValue": <number>,
  "explanation": "<Explanation text>",
  "auctionResults": [ <Array of AuctionItemWithRelevance> ], // Comparable items considered
  "confidenceLevel": <number (e.g., 70)>,
  "marketTrend": <"rising" | "stable" | "declining">,
  "keyFactors": [ <Array of string> ],
  "dataQuality": <"high" | "medium" | "low">
}
```

**Error Response (4xx/5xx):** Standard error format.

### 4. `/api/auction-results`

Retrieves relevant auction results for a keyword, sorted by price (descending).

**Request Body:**
```json
{
  "keyword": "<Search Keyword (string)>",
  "minPrice": <number (optional, default: 1000)>,
  "limit": <number (optional, default: 10)>
}
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "keyword": "<string>",
  "totalResults": <number>,
  "minPrice": <number>,
  "auctionResults": [
    {
      "title": "<string>",
      "price": { "amount": <number>, "currency": "<string>", "symbol": "<string>" },
      "auctionHouse": "<string>", // Note: uses 'auctionHouse' key
      "date": "<string>",
      "lotNumber": "<string>",
      "saleType": "<string>"
    }
    // ... more results
  ]
}
```

**Error Response (4xx/5xx):** Standard error format.

### 5. `/api/wp2hugo-auction-results`

Similar to `/api/auction-results` but provides additional summary information and slightly different formatting (e.g., `house` key instead of `auctionHouse`) specifically for the WP2HUGO workflow.

**Request Body:**
```json
{
  "keyword": "<Search Keyword (string)>",
  "minPrice": <number (optional, default: 1000)>,
  "limit": <number (optional, default: 10)>
}
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "keyword": "<string>",
  "totalResults": <number>,
  "minPrice": <number>,
  "auctionResults": [
     {
      "title": "<string>",
      "price": { "amount": <number>, "currency": "<string>", "symbol": "<string>" },
      "house": "<string>", // Note: uses 'house' key
      "date": "<string>",
      "lotNumber": "<string>",
      "saleType": "<string>"
    }
    // ... more results
  ],
  "summary": "<Generated market summary text>",
  "priceRange": {
    "min": <number>,
    "max": <number>,
    "median": <number>
  },
  "timestamp": "<ISO 8601 string>"
}
```

**Error Response (4xx/5xx):** Returns a specific error format for this endpoint:
```json
{
  "success": false,
  "keyword": "<string>",
  "error": "<Error message>",
  "auctionResults": [],
  "timestamp": "<ISO 8601 string>"
}
```

### 6. `/api/enhanced-statistics`

Generates a comprehensive statistical report for an item, including distribution, trends, comparables, and qualitative scores.

**Request Body:**
```json
{
  "text": "<Item Description (string)>",
  "value": <Target Value for analysis (number)>,
  "limit": <number (optional, default: 20)>,
  "targetCount": <number (optional, default: 100)>,
  "minPrice": <number (optional)>,
  "maxPrice": <number (optional)>
}
```
*   `limit`: Controls the maximum number of `comparable_sales` returned in the response.
*   `targetCount`: Aim for this many auction results during internal data gathering.
*   `minPrice`/`maxPrice`: Filters the auction data used for statistics calculation.

**Success Response (200 OK):**
```json
{
  "success": true,
  "statistics": { <EnhancedStatistics object - see types.ts> },
  "message": "Enhanced statistics generated successfully"
}
```
*   See `src/services/types.ts` for the detailed structure of the `EnhancedStatistics` object.

**Error Response (4xx/5xx):** Standard error format.

### Error Handling

Failed requests (e.g., validation errors, internal server errors) generally return a standard JSON response:

```json
{
  "success": false,
  "error": "<Error message string>",
  // "details": [ ... ] // Optional: Included for Zod validation errors
}
```
*(Exception: `/api/wp2hugo-auction-results` has its own error format, see above)*

## Setup

1.  **Prerequisites:** Node.js (v18+ recommended), npm
2.  **Clone:** `git clone <repository-url>`
3.  **Install Dependencies:** `cd <repository-directory> && npm install`
4.  **Environment Variables:**
    *   Create a `.env` file in the root directory.
    *   Add the following variables:
        ```
        PORT=8080
        GOOGLE_CLOUD_PROJECT_ID=<your-gcp-project-id>
        ```
5.  **Google Cloud Setup:**
    *   Ensure you have a Google Cloud project with the Secret Manager API enabled.
    *   Store your OpenAI API key in Secret Manager with the secret ID `OPENAI_API_KEY`.
    *   Ensure the service account or user running the application has the `Secret Manager Secret Accessor` role (`roles/secretmanager.secretAccessor`).
    *   [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/provide-credentials-adc) should be configured in your environment (e.g., via `gcloud auth application-default login` or service account keys).

## Running the Service

-   **Development:** `npm run dev` (Starts with `tsx` for hot-reloading)
-   **Production:**
    1.  `npm run build` (Compiles TypeScript to JavaScript in `dist/`)
    2.  `npm start` (Runs the compiled code from `dist/`)

## Key Service Components (Post-Refactoring)

-   **`ValuerService`:** Client for fetching raw auction data from the external Valuer API.
-   **`KeywordExtractionService`:** Uses OpenAI to generate relevant search terms based on item descriptions.
-   **`MarketDataService`:** (May need refactoring/merging) Processes raw data from Valuer API into a standardized `SimplifiedAuctionItem` format.
-   **`MarketDataAggregatorService`:** Orchestrates progressive searches across different keyword specificities using `MarketDataService` to gather a target number of relevant items.
-   **`StatisticalAnalysisService`:** Calculates core statistical metrics (mean, median, stddev, etc.) and derived qualitative scores.
-   **`MarketReportService`:** Generates user-facing report components like histograms, price history trends, formatted comparable sales lists, and data quality indicators.
-   **`JustifierAgent`:** Handles endpoints related to direct value justification, estimation, and range finding. Uses `MarketDataService`, `OpenAI Helper`, and potentially `KeywordExtractionService`.
-   **`StatisticsService` (Facade):** Handles the `/api/enhanced-statistics` endpoint by orchestrating calls to the various underlying services (`KeywordExtraction`, `MarketDataAggregator`, `StatisticalAnalysis`, `MarketReport`).
-   **`OpenAI Helper`:** Utility functions for making standardized calls to the OpenAI API and parsing responses.

## Testing

Run the test suite:
```bash
npm test
```
*Note: Tests may need significant updates to reflect the refactored service architecture.*

## Docker Support

Build and run with Docker:

```bash
docker build -t valuation-service .
docker run -p 8080:8080 --env-file .env valuation-service
```
*Ensure your `.env` file is present or configure environment variables appropriately for the container.*

## Scripts

-   `npm run dev`: Start development server with hot reload.
-   `npm run build`: Build for production (compiles TS to JS).
-   `npm start`: Start production server (runs JS from `dist/`).
-   `npm test`: Run Vitest test suite.
-   `npm run lint`: Run ESLint code linter.

## License

MIT License - see LICENSE file for details.