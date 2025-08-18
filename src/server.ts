import express, { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import OpenAI from 'openai';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { ValuerService } from './services/valuer.js';
import { callOpenAIAndParseJson } from './services/utils/openai-helper.js';
import { KeywordExtractionService } from './services/keyword-extraction.service.js';
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
let keyworder: KeywordExtractionService;

// Initialize OpenAI client with secret
async function initializeOpenAI() {
  const apiKey = await getOpenAIKey();
  openai = new OpenAI({ apiKey });
  justifier = new JustifierAgent(openai, valuer);
  statistics = new StatisticsService(openai, valuer);
  keyworder = new KeywordExtractionService(openai);
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
  if (!openai || !justifier || !statistics || !keyworder) {
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
app.use('/api/multi-search', checkServicesInitialized);
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

// New endpoint: multi-search orchestrated via Valuer batch
const MultiSearchSchema = z.object({
  description: z.string(),
  primaryImageUrl: z.string().url().optional(),
  additionalImageUrls: z.array(z.string().url()).optional(),
  minPrice: z.number().optional(),
  maxQueries: z.number().optional(),
  concurrency: z.number().optional(),
  limitPerQuery: z.number().optional(),
  sort: z.string().optional()
});

app.post('/api/multi-search', asyncHandler(async (req, res) => {
  const { description, primaryImageUrl, additionalImageUrls = [], minPrice = Number(process.env.VALUER_MIN_PRICE_DEFAULT || 1000), maxQueries = 5, concurrency = Number(process.env.VALUER_BATCH_CONCURRENCY || 3), limitPerQuery = 100, sort = 'relevance' } = MultiSearchSchema.parse(req.body);

  console.log(`Multi-search request: desc len=${description.length}, maxQueries=${maxQueries}, minPrice=${minPrice}, concurrency=${concurrency}`);

  // Generate exactly 5 search terms using GPT-5, incorporating image URLs contextually for speed-focused screener
  const imagesList = [primaryImageUrl, ...additionalImageUrls.filter(Boolean)].filter(Boolean).slice(0, 3);
  const keywordPrompt = [
    'Generate EXACTLY 5 auction search terms (short, standard catalog terms) for finding comparable items.',
    'Use the description and consider the image URLs as context. Optimize for speed and broad matching.',
    'Return JSON of the form { "terms": ["...", "...", "...", "...", "..."] } with 5 items only.',
    '',
    `Description: ${description}`,
    imagesList.length > 0 ? `Image URLs: ${imagesList.join(', ')}` : ''
  ].join('\n');

  let selected: string[] = [];
  try {
    const termsJson = await callOpenAIAndParseJson<{ terms: string[] }>(openai, {
      model: 'gpt-5',
      systemMessage: 'You are an expert in auction terminology and search optimization. Produce only valid JSON.',
      userPrompt: keywordPrompt,
      expectJsonResponse: true
    });
    const terms = Array.isArray(termsJson?.terms) ? termsJson.terms : [];
    selected = terms.slice(0, 5);
  } catch (e) {
    console.warn('Keyword generation via GPT-5 failed; falling back to text-only extractor:', (e as Error)?.message || e);
    const fallback = await keyworder.extractKeywords(description);
    selected = fallback.slice(0, 5);
  }

  if (selected.length === 0) {
    return res.status(503).json({ success: false, error: 'Failed to generate search terms' });
  }

  const searches = selected.map(q => ({ query: q, 'priceResult[min]': minPrice, limit: limitPerQuery, sort }));
  const tBatch0 = Date.now();
  const batch = await valuer.batchSearch({ searches, concurrency });
  try {
    console.log(`Multi-search batch call returned in ${Date.now() - tBatch0}ms with ${batch?.searches?.length || 0} segments`);
  } catch {}

  // Aggregate compact items for summarization and UI
  type CompactItem = { title?: string; price?: { amount?: number; currency?: string }; auctionHouse?: string; date?: string; url?: string };
  const uniqueTitles = new Set<string>();
  const aggregated: CompactItem[] = [];
  for (const s of batch.searches || []) {
    const lots = s?.result?.data?.lots || [];
    for (const lot of lots) {
      const title: string | undefined = lot?.title || lot?.lotTitle;
      if (!title || uniqueTitles.has(title)) continue;
      uniqueTitles.add(title);
      const priceAmount = (lot?.price && typeof lot.price.amount === 'number') ? lot.price.amount : (typeof lot?.priceResult === 'number' ? lot.priceResult : undefined);
      const currency = lot?.price?.currency || lot?.currency || lot?.currencyCode || 'USD';
      aggregated.push({
        title,
        price: priceAmount ? { amount: priceAmount, currency } : undefined,
        auctionHouse: lot?.auctionHouse || lot?.house || lot?.houseName,
        date: lot?.date || lot?.dateTimeLocal,
        url: lot?.url || lot?.lotUrl || lot?.permalink
      });
      if (aggregated.length >= 100) break;
    }
    if (aggregated.length >= 100) break;
  }

  // Summarize with GPT-5: min/max/mostLikely and pick 10 comparables
  let summary: { minValue: number; maxValue: number; mostLikelyValue: number; comparableItems: CompactItem[] } | null = null;
  try {
    const summaryPrompt = [
      'Given a JSON array of comparable auction items (title, optional price with currency, house, date, url),',
      'infer a reasonable minValue, maxValue, and mostLikelyValue (numbers).',
      'Select the 10 most relevant comparableItems. Return JSON strictly as:',
      '{ "minValue": number, "maxValue": number, "mostLikelyValue": number, "comparableItems": [ { "title": string, "price": number | null, "currency": string | null, "auctionHouse": string | null, "date": string | null, "url": string | null } ] }',
      '',
      `Items JSON: ${JSON.stringify(aggregated.slice(0, 60))}`
    ].join('\n');
    const parsed = await callOpenAIAndParseJson<any>(openai, {
      model: 'gpt-5',
      systemMessage: 'You are a valuation assistant. Output only valid JSON.',
      userPrompt: summaryPrompt,
      expectJsonResponse: true
    });
    if (parsed && typeof parsed === 'object') {
      const items = Array.isArray(parsed.comparableItems) ? parsed.comparableItems.slice(0, 10) : [];
      summary = {
        minValue: Number(parsed.minValue || 0),
        maxValue: Number(parsed.maxValue || 0),
        mostLikelyValue: Number(parsed.mostLikelyValue || 0),
        comparableItems: items.map((it: any) => ({
          title: String(it.title || ''),
          price: typeof it.price === 'number' ? { amount: it.price, currency: it.currency || 'USD' } : undefined,
          auctionHouse: it.auctionHouse || null,
          date: it.date || null,
          url: it.url || null
        }))
      };
    }
  } catch (e) {
    console.warn('Summarization via GPT-5 failed:', (e as Error)?.message || e);
  }

  res.json({
    success: true,
    generatedQueries: selected,
    sources: { valuerBatch: true },
    data: {
      lots: aggregated,
      byQuery: batch.searches
    },
    stats: batch.batch || { total: searches.length, completed: (batch.searches || []).length },
    summary: summary || undefined
  });
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