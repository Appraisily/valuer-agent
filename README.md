# AI Valuation Justifier Service

An intelligent service that provides detailed justifications for antique and collectible valuations using OpenAI's GPT model and real-time market data from auction houses.

## Features

- 🤖 AI-powered valuation analysis using OpenAI's GPT model
- 📊 Real-time market data comparison from auction houses
- 🔒 Secure secret management using Google Cloud Secret Manager
- 🚀 Ready for deployment on Google Cloud Run
- ✨ TypeScript support with full type safety
- 🧪 Testing setup with Vitest

## Prerequisites

- Node.js 20 or higher
- Google Cloud Platform account
- OpenAI API key
- Docker (for containerization)

## Environment Setup

1. Create a Google Cloud project and enable necessary APIs:
   ```bash
   gcloud services enable run.googleapis.com secretmanager.googleapis.com
   ```

2. Store your OpenAI API key in Secret Manager:
   ```bash
   gcloud secrets create OPENAI_API_KEY --replication-policy="automatic"
   echo -n "your-actual-key" | gcloud secrets versions add OPENAI_API_KEY --data-file=-
   ```

3. Grant Secret Manager access to your service account:
   ```bash
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
       --member="serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
       --role="roles/secretmanager.secretAccessor"
   ```

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

The server will start on port 8080 (or the port specified in your environment).

## API Usage

The service provides three main endpoints for antique and collectible valuation:

### 1. Find Value
Calculates a specific value for an item based on market data.

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
  "explanation": "Detailed analysis based on comparable auction results..."
}
```

### 2. Find Value Range
Provides a broad value range accounting for variations in condition and market factors.

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
  "explanation": "Detailed analysis of value range factors..."
}
```

### 3. Justify Value
Analyzes whether a proposed value is reasonable based on market data.

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
  "justification": "Detailed analysis comparing the proposed value to market data..."
}
```

All endpoints:
- Use real-time auction data for comparisons
- Provide detailed explanations citing specific comparable sales
- Handle errors gracefully with appropriate status codes
- Validate input using Zod schema

## Testing

Run the test suite:
```bash
npm test
```

## Deployment

1. Build the Docker image:
   ```bash
   docker build -t gcr.io/YOUR_PROJECT_ID/justifier-agent .
   ```

2. Push to Google Container Registry:
   ```bash
   docker push gcr.io/YOUR_PROJECT_ID/justifier-agent
   ```

3. Deploy to Cloud Run:
   ```bash
   gcloud run deploy justifier-agent \
       --image gcr.io/YOUR_PROJECT_ID/justifier-agent \
       --platform managed \
       --allow-unauthenticated
   ```

## Architecture

The service consists of three main components:

1. **JustifierAgent**: Interfaces with OpenAI's GPT model to generate detailed value justifications
2. **ValuerService**: Fetches comparable items from auction house databases
3. **Express Server**: Handles HTTP requests and manages the API endpoints

## Security

- OpenAI API key is securely stored in Google Cloud Secret Manager
- Input validation using Zod schema
- Error handling and sanitization
- Rate limiting support through the Valuer service

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- OpenAI for providing the GPT model
- Invaluable API for auction house data
- Google Cloud Platform for hosting and secret management