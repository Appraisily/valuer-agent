# AI Valuation Justifier Service

An intelligent service that provides detailed justifications for antique and collectible valuations using OpenAI's GPT model and real-time market data.

## Features

- 🤖 AI-powered valuation analysis using OpenAI's GPT model
- 📊 Real-time market data integration
- 🎯 Precise value estimation with detailed justifications
- 📈 Value range analysis with confidence levels
- 🔍 Smart search strategy for finding comparable items
- ✨ TypeScript with full type safety
- 🧪 Comprehensive test suite

## Project Structure

```
src/
├── server.ts              # Express server setup and API routes
├── services/
│   ├── justifier-agent.ts # Main AI valuation logic
│   ├── market-data.ts     # Market data processing
│   ├── valuer.ts         # External valuation service integration
│   ├── types.ts          # Shared TypeScript interfaces
│   ├── prompts/          # AI prompt templates
│   │   └── index.ts
│   └── utils/
│       └── tokenizer.ts   # Token management utilities
└── tests/                # Test suites
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
  "explanation": "Analysis of value range factors..."
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
  "justification": "Detailed market analysis..."
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
   - Implements valuation logic and analysis
   - Handles search strategy generation

2. **MarketDataService**
   - Processes and normalizes market data
   - Implements token management for large datasets
   - Handles data relevance scoring

3. **ValuerService**
   - Integrates with external valuation APIs
   - Manages market data retrieval
   - Implements price range calculations

### Type Safety

The project uses TypeScript with strict type checking:

```typescript
interface ValueResponse {
  value: number;
  explanation: string;
}

interface ValueRangeResponse {
  minValue: number;
  maxValue: number;
  mostLikelyValue: number;
  explanation: string;
}
```

### Testing

Run the test suite:
```bash
npm test
```

## Docker Support

Build and run with Docker:

```bash
docker build -t valuation-justifier .
docker run -p 8080:8080 valuation-justifier
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - see LICENSE file for details