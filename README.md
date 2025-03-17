# AI Valuation Justifier Service

An intelligent service that provides detailed justifications for antique and collectible valuations using OpenAI's GPT model and real-time market data.

## Tech Stack

- 🚀 Node.js with Express
- 🔒 Google Cloud Secret Manager for secure API key storage
- 🤖 OpenAI GPT integration
- ✨ TypeScript with strict type safety
- 🧪 Vitest for testing
- 🐳 Docker support

## Features

- 🤖 AI-powered valuation analysis using OpenAI's GPT model
- 📊 Real-time market data integration via Valuer API
- 🎯 Precise value estimation with detailed justifications
- 📈 Value range analysis with confidence levels
- 🔍 Smart search strategy for finding comparable items
- 🔎 Valuable auction results discovery from keywords
- 🔐 Secure API key management
- 🧪 Comprehensive test suite

## Project Structure

```
src/
├── server.ts                # Express server setup and API routes
├── services/
│   ├── justifier-agent.ts   # Main AI valuation logic
│   ├── market-data.ts       # Market data processing
│   ├── valuer.ts           # Valuer API integration
│   ├── types.ts            # Shared TypeScript interfaces
│   ├── prompts/            # AI prompt templates
│   │   └── index.ts
│   └── utils/
│       └── tokenizer.ts     # Token management utilities
└── tests/                  # Test suites
```

## API Endpoints

### Find Value
Calculates a specific value with detailed justification.

```http
POST /api/find-value
Content-Type: application/json

{
  "text": "Antique Victorian mahogany dining table, circa 1860"
}
```

Response:
```json
{
  "success": true,
  "value": 2500,
  "explanation": "Detailed analysis based on market data..."
}
```

### Find Value Range
Provides a value range with confidence levels.

```http
POST /api/find-value-range
Content-Type: application/json

{
  "text": "Antique Victorian mahogany dining table, circa 1860"
}
```

Response:
```json
{
  "success": true,
  "minValue": 1500,
  "maxValue": 5000,
  "mostLikelyValue": 2500,
  "explanation": "Analysis of value range factors...",
  "auctionResults": [
    {
      "title": "Similar antique table",
      "price": 2300,
      "currency": "USD",
      "house": "Example Auction House",
      "date": "2024-01-15",
      "description": "Detailed item description..."
    }
  ]
}
```

### Justify Value
Analyzes whether a proposed value is reasonable.

```http
POST /api/justify
Content-Type: application/json

{
  "text": "Antique Victorian mahogany dining table, circa 1860",
  "value": 2500
}
```

Response:
```json
{
  "success": true,
  "explanation": "Concise justification of the value based on auction results (under 100 words)",
  "auctionResults": [
    {
      "title": "Similar antique table",
      "price": 2300,
      "currency": "USD",
      "house": "Example Auction House",
      "date": "2024-01-15",
      "description": "Detailed item description..."
    }
  ]
}
```

### Find Valuable Auction Results
Retrieves valuable auction results for a specific search keyword.

```http
POST /api/auction-results
Content-Type: application/json

{
  "keyword": "Elgin Pocket Watch", 
  "minPrice": 1000,  // Optional, defaults to 1000
  "limit": 10        // Optional, defaults to 10
}
```

Response:
```json
{
  "success": true,
  "keyword": "Elgin Pocket Watch",
  "totalResults": 3,
  "minPrice": 1000,
  "auctionResults": [
    {
      "title": "Antique 14K Gold Elgin Pocket Watch",
      "price": {
        "amount": 2500,
        "currency": "USD",
        "symbol": "$"
      },
      "auctionHouse": "Sotheby's",
      "date": "2023-05-15",
      "lotNumber": "156",
      "saleType": "Online Auction"
    },
    // Additional auction results...
  ]
}
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up environment variables:
   ```bash
   PORT=8080
   GOOGLE_CLOUD_PROJECT_ID=your-project-id
   ```

3. Start development server:
   ```bash
   npm run dev
   ```

## Development

### Key Components

1. **JustifierAgent**
   - Manages interaction with OpenAI's GPT model
   - Implements smart search strategies
   - Handles value analysis and justification

2. **MarketDataService**
   - Processes and normalizes market data
   - Implements token management
   - Handles data relevance scoring

3. **ValuerService**
   - Integrates with Valuer API
   - Manages market data retrieval
   - Implements price range calculations

### Testing

Run the test suite:
```bash
npm test
```

The test suite includes:
- Unit tests for the JustifierAgent
- Value calculation validation
- Range analysis verification
- API endpoint testing

## Docker Support

Build and run with Docker:

```bash
docker build -t valuation-justifier .
docker run -p 8080:8080 valuation-justifier
```

## Environment Variables

- `PORT`: Server port (default: 8080)
- `GOOGLE_CLOUD_PROJECT_ID`: Google Cloud project ID for Secret Manager
- OpenAI API key (stored in Google Cloud Secret Manager)

## Scripts

- `npm run dev`: Start development server with hot reload
- `npm run build`: Build for production
- `npm start`: Start production server
- `npm test`: Run test suite
- `npm run lint`: Run ESLint

## License

MIT License - see LICENSE file for details