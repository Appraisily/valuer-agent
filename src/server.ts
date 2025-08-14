import express, { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import OpenAI from 'openai';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { ValuerService } from './services/valuer.js';
import { JustifierAgent } from './services/justifier-agent.js';
import { StatisticsService } from './services/statistics-service.js';

async function getOpenAIKey() {
  // For local development, check if direct API key is provided
  if (process.env.OPENAI_API_KEY) {
    console.log('Using OPENAI_API_KEY from environment variables');
    return process.env.OPENAI_API_KEY;
  }

  // For Cloud Run, use Secret Manager. Auto-detect project ID when not provided.
  try {
    const client = new SecretManagerServiceClient();
    const detectedProjectId = await client.getProjectId();
    const projectId = (
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      process.env.PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT_ID ||
      detectedProjectId
    );

    const name = `projects/${projectId}/secrets/OPENAI_API_KEY/versions/latest`;

    const [version] = await client.accessSecretVersion({ name });
    return version.payload?.data?.toString() || '';
  } catch (error) {
    console.error('Error fetching OpenAI API key from Secret Manager:', error);
    throw error;
  }
}

const app = express();
app.use(express.json());

let openai: OpenAI;
let justifier: JustifierAgent;
let statistics: StatisticsService;
const valuer = new ValuerService();

// Initialize OpenAI client with secret
async function initializeOpenAI() {
  const apiKey = await getOpenAIKey();
  openai = new OpenAI({ apiKey });
  justifier = new JustifierAgent(openai, valuer);
  statistics = new StatisticsService(openai, valuer);
}

const RequestSchema = z.object({
  text: z.string(),
  value: z.number(),
});

const FindValueRequestSchema = z.object({
  text: z.string(),
  useAccurateModel: z.boolean().optional(),
});

const AuctionResultsRequestSchema = z.object({
  keyword: z.string(),
  minPrice: z.number().optional(),
  limit: z.number().optional(),
});

const EnhancedStatisticsRequestSchema = z.object({
  text: z.string(),
  value: z.number(),
  limit: z.number().optional(),
  targetCount: z.number().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
});

// Middleware to check if essential services are initialized
const checkServicesInitialized = (_req: Request, _res: Response, next: NextFunction) => {
  if (!openai || !justifier || !statistics) {
    // Use next(error) to pass control to the error handling middleware
    return next(new Error('Core services not initialized'));
  }
  next(); // Services are initialized, proceed to the next middleware/route handler
};

// Shared function to process auction results
async function processAuctionResults(keyword: string, minPrice: number = 1000, limit: number = 10, format: 'standard' | 'wp2hugo' = 'standard') {
  console.log(`${format === 'wp2hugo' ? 'WP2HUGO' : 'Standard'} auction results request for: "${keyword}" (minPrice: ${minPrice}, limit: ${limit})`);
  const results = await valuer.findValuableResults(keyword, minPrice, limit);

  // Common processing
  const hits = results.hits;
  const prices = hits.map(hit => hit.priceResult).filter(p => p > 0);
  const minFoundPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxFoundPrice = prices.length > 0 ? Math.max(...prices) : 0;

  let medianPrice = 0;
  if (prices.length > 0) {
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const midIndex = Math.floor(sortedPrices.length / 2);
    medianPrice = sortedPrices.length % 2 === 0
      ? (sortedPrices[midIndex - 1] + sortedPrices[midIndex]) / 2
      : sortedPrices[midIndex];
  }

  // Format results based on the requested format
  const auctionResults = hits.map(hit => ({
    title: hit.lotTitle,
    price: {
      amount: hit.priceResult,
      currency: hit.currencyCode,
      symbol: hit.currencySymbol
    },
    // Use 'house' for wp2hugo format, 'auctionHouse' otherwise (though source data uses houseName)
    [format === 'wp2hugo' ? 'house' : 'auctionHouse']: hit.houseName,
    date: hit.dateTimeLocal,
    lotNumber: hit.lotNumber,
    saleType: hit.saleType
  }));

  if (format === 'wp2hugo') {
    let summary = "";
    if (auctionResults.length > 0) {
      const currencyCode = hits[0]?.currencyCode || 'USD';
      summary = `Based on ${auctionResults.length} recent auction results, ${keyword} typically sell for between ${minFoundPrice} and ${maxFoundPrice} ${currencyCode}, with a median value of approximately ${Math.round(medianPrice)} ${currencyCode}. Prices can vary significantly based on condition, rarity, provenance, and market demand.`;
    } else {
      summary = `Limited auction data is available for ${keyword}. Values may vary significantly based on condition, rarity, provenance, and market demand.`;
    }
    return {
      success: true,
      keyword,
      totalResults: auctionResults.length,
      minPrice, // Return the requested minPrice
      auctionResults,
      summary,
      priceRange: {
        min: minFoundPrice,
        max: maxFoundPrice,
        median: medianPrice
      },
      timestamp: new Date().toISOString()
    };
  } else {
    // Standard format
    return {
      success: true,
      keyword,
      totalResults: auctionResults.length,
      minPrice: minPrice, // Return the requested minPrice
      auctionResults
    };
  }
}

// Helper function to wrap async route handlers and catch errors
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next); // Errors caught here are passed to the error handler
  };


// Apply initialization check middleware to all /api routes that need it
app.use('/api/justify', checkServicesInitialized);
app.use('/api/find-value', checkServicesInitialized);
app.use('/api/find-value-range', checkServicesInitialized);
// Note: /api/auction-results and /api/wp2hugo-auction-results only need 'valuer', which is initialized synchronously.
// Note: /api/enhanced-statistics needs 'statistics' service.
app.use('/api/enhanced-statistics', checkServicesInitialized);


app.post('/api/justify', asyncHandler(async (req, res) => {
  // Initialization check is done by middleware
  // Error handling is done by middleware

  const { text, value } = RequestSchema.parse(req.body);
  const result = await justifier.justify(text, value);
  res.json({
    success: true,
    explanation: result.explanation,
    auctionResults: result.auctionResults,
    allSearchResults: result.allSearchResults
  });
}));

app.post('/api/find-value', asyncHandler(async (req, res) => {
  // Initialization check is done by middleware
  // Error handling is done by middleware

  const { text } = FindValueRequestSchema.parse(req.body); // Only text is needed here
  const result = await justifier.findValue(text);

  res.json({
    success: true,
    value: result.value,
    explanation: result.explanation
  });
}));

app.post('/api/find-value-range', asyncHandler(async (req, res) => {
  // Initialization check is done by middleware
  // Error handling is done by middleware

  // Use FindValueRequestSchema here as it includes 'text' and 'useAccurateModel'
  const { text, useAccurateModel } = FindValueRequestSchema.parse(req.body);

  console.log(`Processing find-value-range request for: "${text.substring(0, 100)}..." (useAccurateModel: ${useAccurateModel === true})`);

  const result = await justifier.findValueRange(text, useAccurateModel === true);

  res.json({
    success: true,
    minValue: result.minValue,
    maxValue: result.maxValue,
    mostLikelyValue: result.mostLikelyValue,
    explanation: result.explanation,
    auctionResults: result.auctionResults || [],
    confidenceLevel: result.confidenceLevel,
    marketTrend: result.marketTrend,
    keyFactors: result.keyFactors,
    dataQuality: result.dataQuality
  });

  console.log(`Completed find-value-range request with confidence: ${result.confidenceLevel}, trend: ${result.marketTrend}`);
}));

app.post('/api/auction-results', asyncHandler(async (req, res) => {
  // Valuer service is initialized synchronously, no async check needed here
  // Error handling is done by middleware
  const { keyword, minPrice, limit } = AuctionResultsRequestSchema.parse(req.body);
  const results = await processAuctionResults(keyword, minPrice, limit, 'standard');
  res.json(results);
}));

// Keep the WP2HUGO endpoint separate but use the shared function
app.post('/api/wp2hugo-auction-results', asyncHandler(async (req, res) => {
  // Valuer service is initialized synchronously, no async check needed here
  // Error handling is done by middleware
  const { keyword, minPrice = 1000, limit = 10 } = AuctionResultsRequestSchema.parse(req.body);
  const results = await processAuctionResults(keyword, minPrice, limit, 'wp2hugo');
  res.json(results);
}));


app.post('/api/enhanced-statistics', asyncHandler(async (req, res) => {
  // Initialization check is done by middleware
  // Error handling is done by middleware

  const { text, value, limit = 20, targetCount = 100, minPrice, maxPrice } = EnhancedStatisticsRequestSchema.parse(req.body);
  console.log(`Enhanced statistics request for: "${text}" with value ${value} (target count: ${targetCount}, price range: ${minPrice || 'auto'}-${maxPrice || 'auto'})`);

  const enhancedStats = await statistics.generateStatistics(text, value, targetCount, minPrice, maxPrice);

  // Apply limit if necessary
  if (limit > 0 && enhancedStats.comparable_sales.length > limit) {
    const originalCount = enhancedStats.comparable_sales.length;
    enhancedStats.comparable_sales = enhancedStats.comparable_sales.slice(0, limit);
    enhancedStats.total_count = originalCount; // Keep track of the original total before limiting
    console.log(`Limited comparable sales from ${originalCount} to ${limit} for UI display`);
  }

  res.json({
    success: true,
    statistics: enhancedStats,
    message: 'Enhanced statistics generated successfully'
  });
}));


// Error Handling Middleware - Must be the last middleware added
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error(`Error processing request ${req.method} ${req.path}:`, err);

  // Handle JSON parsing errors (malformed JSON)
  if (err instanceof SyntaxError && 'body' in err) {
    console.log('Received malformed JSON:', err.message);
    
    // Get example request body based on endpoint
    const exampleRequestBody = getExampleRequestBody(req.path);
    
    return res.status(400).json({
      success: false,
      error: 'Malformed JSON request',
      message: 'Your request contains invalid JSON syntax. Please check your request body.',
      correctFormat: {
        description: `Here's the correct format for ${req.path}:`,
        example: exampleRequestBody
      }
    });
  }

  // Handle Zod validation errors specifically
  if (err instanceof ZodError) {
    // Get example request body based on endpoint
    const exampleRequestBody = getExampleRequestBody(req.path);
    
    return res.status(400).json({
      success: false,
      error: 'Invalid request body',
      details: err.errors,
      correctFormat: {
        description: `Here's the correct format for ${req.path}:`,
        example: exampleRequestBody
      }
    });
  }

  // Handle other errors
  const statusCode = (err as any).status || 500; // Use err.status if available, otherwise 500
  const message = err.message || 'Internal Server Error';

  // For WP2HUGO errors, return the specific format expected
  if (req.path === '/api/wp2hugo-auction-results') {
    return res.status(statusCode).json({
        success: false,
        keyword: req.body?.keyword || '', // Attempt to include keyword if available
        error: message,
        auctionResults: [],
        timestamp: new Date().toISOString()
    });
  }

  // Standard error response
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500) // Ensure valid HTTP status code
    .json({
    success: false,
    error: message,
  });
});

/**
 * Get example request body based on endpoint path
 */
function getExampleRequestBody(path: string): any {
  switch (path) {
    case '/api/justify':
      return {
        text: "Antique sterling silver tea set from the Victorian era, circa 1880",
        value: 2500
      };
    
    case '/api/find-value':
      return {
        text: "Antique sterling silver tea set from the Victorian era, circa 1880"
      };
    
    case '/api/find-value-range':
      return {
        text: "Antique sterling silver tea set from the Victorian era, circa 1880",
        useAccurateModel: true // Optional, defaults to false
      };
    
    case '/api/auction-results':
      return {
        keyword: "Victorian silver tea set",
        minPrice: 1000, // Optional, defaults to 1000
        limit: 10 // Optional, defaults to 10
      };
    
    case '/api/wp2hugo-auction-results':
      return {
        keyword: "Victorian silver tea set",
        minPrice: 1000, // Optional, defaults to 1000
        limit: 10 // Optional, defaults to 10
      };
    
    case '/api/enhanced-statistics':
      return {
        text: "Original Jean-Michel Basquiat Painting, 8.25x12 inches, untitled work from 1982",
        value: 5000000,
        limit: 20, // Optional, defaults to 20
        targetCount: 100, // Optional, defaults to 100
        minPrice: 1000000, // Optional
        maxPrice: 10000000 // Optional
      };
    
    default:
      return {
        message: "Unknown endpoint. Please check the API documentation."
      };
  }
}

const port = process.env.PORT || 8080;

// Initialize OpenAI before starting server
initializeOpenAI().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}).catch(error => {
  console.error('Failed to initialize OpenAI client:', error);
  console.error('Make sure either GOOGLE_CLOUD_PROJECT_ID is set for Secret Manager OR OPENAI_API_KEY is provided directly');
  process.exit(1);
});