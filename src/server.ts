import express, { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import OpenAI from 'openai';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { ValuerService } from './services/valuer.js';
import { buildQueryPyramid, flattenPyramid } from './services/query-pyramid.js';
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
app.use('/v2/search/batch', checkServicesInitialized);
// Note: /api/auction-results and /api/wp2hugo-auction-results only need 'valuer', which is initialized synchronously.
// Note: /api/enhanced-statistics needs 'statistics' service.
app.use('/api/enhanced-statistics', checkServicesInitialized);


app.post('/api/justify', asyncHandler(async (req, res) => {
  const mode = String(process.env.VALUER_JUSTIFY_DEPRECATION_MODE || 'notice');
  if (mode === 'gone') {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/multi-search>; rel="alternate"');
    return res.status(410).json({
      success: false,
      error: 'Endpoint deprecated. Use /api/multi-search with { justify: true, targetValue }.',
      alternative: {
        endpoint: '/api/multi-search',
        body: { description: '...', targetValue: 2500, justify: true }
      }
    });
  }
  // Initialization check is done by middleware
  // Error handling is done by middleware

  const { text, value } = RequestSchema.parse(req.body);
  const result = await justifier.justify(text, value);
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Fri, 31 Oct 2025 00:00:00 GMT');
  res.set('Link', '</api/multi-search>; rel="alternate"');
  console.warn('DEPRECATION: /api/justify is deprecated. Use /api/multi-search with { justify: true, targetValue }');
  res.json({
    success: true,
    deprecation: {
      message: 'This endpoint is deprecated and will be removed. Use /api/multi-search with { justify: true, targetValue }.',
      alternative: { endpoint: '/api/multi-search', body: { description: '...', targetValue: value, justify: true } },
      sunset: '2025-10-31T00:00:00.000Z'
    },
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
  maxPrice: z.number().optional(),
  concurrency: z.number().optional(),
  limitPerQuery: z.number().optional(),
  sort: z.string().optional(),
  timeoutMs: z.number().optional(),
  retries: z.number().optional(),
  maxQueries: z.number().optional(),
  terms: z.array(z.string()).optional(),
  skipSummary: z.boolean().optional(),
  maxItems: z.number().optional(),
  // New: allow passing the appraiser's value to run in justification mode
  targetValue: z.number().optional(),
  justify: z.boolean().optional(),
  // Pyramid controls and structured hints
  usePyramid: z.boolean().optional(),
  category: z.string().optional(),
  maker: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  subject: z.string().optional(),
  styleEra: z.string().optional(),
  mediumMaterial: z.string().optional(),
  region: z.string().optional()
});

app.post('/api/multi-search', asyncHandler(async (req, res) => {
  const { description, primaryImageUrl, additionalImageUrls = [], minPrice, maxPrice, concurrency = Number(process.env.VALUER_BATCH_CONCURRENCY || 5), limitPerQuery = 100, sort = 'relevance', timeoutMs, retries, maxQueries, terms, skipSummary = false, maxItems, targetValue, justify, category, maker, brand, model, subject, styleEra, mediumMaterial, region } = MultiSearchSchema.parse(req.body);

  // Enforce upstream ownership of term generation: require non-empty terms[]
  const providedTerms = Array.isArray(terms) ? Array.from(new Set(terms.map(t => String(t).trim()).filter(Boolean))) : [];
  if (providedTerms.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'terms_required',
      message: 'Provide non-empty terms[]; term generation is disabled in this deployment.'
    });
  }

  // Derive min/max around target when in justification mode
  const justifyMode = Boolean(justify || (typeof targetValue === 'number' && isFinite(targetValue)));
  // Use asymmetric band around appraiser value (default: 50%–200%)
  const bandLow = (() => {
    const v = Number(process.env.VALUER_JUSTIFY_LOW_FACTOR);
    if (Number.isFinite(v) && v > 0 && v < 1) return v;
    return 0.5;
  })();
  const bandHigh = (() => {
    const v = Number(process.env.VALUER_JUSTIFY_HIGH_FACTOR);
    if (Number.isFinite(v) && v > 1) return v;
    return 2.0;
  })();
  const floorMin = Math.max(0, Number(process.env.VALUER_JUSTIFY_MIN_FLOOR || 100));
  const effMinPrice = (() => {
    if (typeof minPrice === 'number') return minPrice;
    if (justifyMode && typeof targetValue === 'number' && isFinite(targetValue)) {
      return Math.max(floorMin, Math.floor(targetValue * bandLow));
    }
    return Number(process.env.VALUER_MIN_PRICE_DEFAULT || 250);
  })();
  const effMaxPrice = (() => {
    if (typeof maxPrice === 'number') return maxPrice;
    if (justifyMode && typeof targetValue === 'number' && isFinite(targetValue)) {
      return Math.ceil(targetValue * bandHigh);
    }
    return undefined;
  })();

  console.log(`Multi-search request: desc len=${description.length}, minPrice=${effMinPrice}${effMaxPrice ? `, maxPrice=${effMaxPrice}` : ''}, concurrency=${concurrency}, justify=${justifyMode}`);

  // Generate search terms using the domain-aware pyramid when requested or when no explicit terms are passed.
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
  if (Array.isArray(terms) && terms.length > 0) {
    selected = Array.from(new Set(terms.map(t => String(t).trim()).filter(Boolean)));
  } else {
    // Default: use pyramid (specific -> broad). Fallback to GPT extraction only if pyramid fails
    try {
      const pyramid = buildQueryPyramid({ description, category, maker, brand, model, subject, styleEra, mediumMaterial, region });
      const cap = Math.max(1, Math.min(20, typeof maxQueries === 'number' ? maxQueries : 10));
      selected = flattenPyramid(pyramid, cap);
      console.log(`Using pyramid queries (${selected.length}): ${selected.join(' | ')}`);
    } catch (e) {
      console.warn('Pyramid query build failed; falling back to keyword generation:', (e as Error)?.message || e);
      try {
        const termsJson = await callOpenAIAndParseJson<{ terms: string[] }>(openai, {
          model: 'gpt-5',
          systemMessage: 'You are an expert in auction terminology and search optimization. Produce only valid JSON.',
          userPrompt: keywordPrompt,
          expectJsonResponse: true
        });
        const t = Array.isArray(termsJson?.terms) ? termsJson.terms : [];
        const cap = Math.max(1, Math.min(10, typeof maxQueries === 'number' ? maxQueries : 5));
        selected = t.slice(0, cap);
      } catch (e2) {
        console.warn('Keyword generation via GPT-5 failed; falling back to text-only extractor:', (e2 as Error)?.message || e2);
        const fallback = await keyworder.extractKeywords(description);
        const cap = Math.max(1, Math.min(10, typeof maxQueries === 'number' ? maxQueries : 5));
        selected = fallback.slice(0, cap);
      }
    }
  }

  if (selected.length === 0) {
    return res.status(503).json({ success: false, error: 'Failed to generate search terms' });
  }

  const perQueryLimit = (() => {
    const cap = Math.max(1, selected.length || 1);
    if (typeof maxItems === 'number' && maxItems > 0) {
      const adaptive = Math.ceil(maxItems / cap);
      return Math.min(limitPerQuery, Math.max(20, adaptive));
    }
    return limitPerQuery;
  })();
  // Determine an effective cap for total unique lots, if any.
  // Priority:
  // 1) Request `maxItems`
  // 2) Env `VALUER_EARLY_STOP_AT` (>0)
  // 3) Otherwise, no cap (Infinity) – allows up to queries*tierLimit (e.g., 6*96)
  const _envEarlyStop = Number(process.env.VALUER_EARLY_STOP_AT);
  const HAS_ENV_CAP = Number.isFinite(_envEarlyStop) && _envEarlyStop > 0;
  const MAX_ITEMS_TOTAL = (typeof maxItems === 'number' && maxItems > 0)
    ? Math.ceil(maxItems)
    : (HAS_ENV_CAP ? Math.ceil(_envEarlyStop) : Infinity);
  const tBatch0 = Date.now();
  // Aggregate compact items for summarization and UI
  type CompactItem = { title?: string; price?: { amount?: number; currency?: string }; auctionHouse?: string; date?: string; url?: string };
  const uniqueTitles = new Set<string>();
  let aggregated: CompactItem[] = [];
  const byQuery: any[] = [];
  const allExecutedQueries: string[] = [];
  let cumulativeStats = { total: 0, completed: 0, failed: 0, durationMs: 0 };
  // Build tiered queries. Prefer caller-provided terms when present to keep WS as the owner of term generation.
  let tiers: Array<{ name: string; terms: string[] }>;
  if (Array.isArray(terms) && terms.length > 0) {
    const src = Array.from(new Set(terms.map(t => String(t).trim()).filter(Boolean)));
    // Optionally split provided terms into pseudo-tiers (9-9-3) so logs show per-tier execution.
    // Enabled by default when enough terms are provided; can be disabled via env.
    const splitEnv = String(process.env.PROVIDED_TIER_SPLIT || 'true').toLowerCase();
    const splitEnabled = (splitEnv === '1' || splitEnv === 'true' || splitEnv === 'yes');
    if (splitEnabled && src.length >= 3) {
      const verySpecific = src.slice(0, 9);
      const specific = src.slice(9, 18);
      const broad = src.slice(18, 21);
      tiers = [];
      if (verySpecific.length) tiers.push({ name: 'very specific', terms: verySpecific });
      if (specific.length) tiers.push({ name: 'specific', terms: specific });
      if (broad.length) tiers.push({ name: 'broad', terms: broad });
      try {
        console.log('Tier plan (provided terms):', {
          verySpecific: verySpecific.length,
          specific: specific.length,
          broad: broad.length,
          total: src.length
        });
      } catch (_) {}
    } else {
      tiers = [ { name: 'provided', terms: src } ];
    }
  } else {
    const pyramidRun = buildQueryPyramid({ description, category, maker, brand, model, subject, styleEra, mediumMaterial, region });
    tiers = [
      { name: 'very specific', terms: pyramidRun['very specific'] || [] },
      { name: 'specific', terms: pyramidRun['specific'] || [] },
      { name: 'moderate', terms: pyramidRun['moderate'] || [] },
      { name: 'broad', terms: pyramidRun['broad'] || [] },
      { name: 'very broad', terms: pyramidRun['very broad'] || [] },
    ];
  }

  let remainingBudget = typeof maxQueries === 'number' ? Math.max(1, maxQueries) : Infinity;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (remainingBudget <= 0) break;
    const clean = tier.terms.filter(Boolean);
    // Try to ensure we execute at least `concurrency` queries per tier when possible,
    // while not exceeding the remaining overall budget and spreading across tiers.
    const tiersLeft = (tiers.length - i);
    const spread = Math.ceil(remainingBudget / Math.max(1, tiersLeft));
    const desiredForTier = Math.max(concurrency, spread);
    const takeCount = Math.min(remainingBudget, Math.min(desiredForTier, clean.length));
    const tierTerms = clean.slice(0, takeCount);
    if (tierTerms.length === 0) continue;

    // Log the exact queries this tier will execute
    try {
      console.log(`Executing tier "${tier.name}" queries: ${tierTerms.join(' | ')}`);
    } catch (_) {}

    const searchesTier = tierTerms.map(q => {
      const priceResult: any = { min: String(effMinPrice) };
      if (typeof effMaxPrice === 'number') priceResult.max = String(effMaxPrice);
      return ({ query: q, priceResult, limit: perQueryLimit, sort });
    });

    const t0 = Date.now();
    const batchTier = await valuer.batchSearch({
      searches: searchesTier,
      concurrency: Math.min(concurrency, searchesTier.length),
      // Fetch ONLY the first page per query
      fetchAllPages: false
    }, {
      timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : Number(process.env.VALUER_BATCH_HTTP_TIMEOUT_MS || 0) || undefined,
      retry: typeof retries === 'number' ? { attempts: retries } : undefined,
    });
    const tierDuration = Date.now() - t0;
    console.log(`Batch search completed: total=${batchTier?.batch?.total || searchesTier.length}, completed=${batchTier?.batch?.completed || 0}, failed=${batchTier?.batch?.failed || 0}, concurrency=${Math.min(concurrency, searchesTier.length)}, durationMs=${tierDuration}`);
    cumulativeStats.total += batchTier?.batch?.total || searchesTier.length;
    cumulativeStats.completed += batchTier?.batch?.completed || 0;
    cumulativeStats.failed += batchTier?.batch?.failed || 0;
    cumulativeStats.durationMs += tierDuration;

    allExecutedQueries.push(...tierTerms);
    remainingBudget = isFinite(remainingBudget) ? Math.max(0, remainingBudget - tierTerms.length) : remainingBudget;

    const preCount = aggregated.length;
    let addedThisTier = 0;
    for (const s of batchTier.searches || []) {
      const lots = s?.result?.data?.lots || [];
      const meta = { query: s?.query || '', lotsCount: Array.isArray(lots) ? lots.length : 0, error: s?.error || undefined };
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
        addedThisTier++;
        if (aggregated.length >= MAX_ITEMS_TOTAL) break;
      }
      if (aggregated.length >= MAX_ITEMS_TOTAL) break;
      byQuery.push({ ...s, meta });
    }
    const added = aggregated.length - preCount;
    console.log(`Tier="${tier.name}" contributed ${added} unique lots (total=${aggregated.length})`);
    if (Number.isFinite(MAX_ITEMS_TOTAL) && aggregated.length >= MAX_ITEMS_TOTAL) {
      console.log(`Cap reached at ${MAX_ITEMS_TOTAL} unique lots. Halting further tiers.`);
      break;
    }
  }

  // Aggregation complete; proceed to optional fallback if needed

  // Fallback: if nothing found, try again with lower minPrice and broader terms
  if (aggregated.length === 0) {
    try {
      const fallbackMin = Math.max(0, Math.floor((minPrice ?? Number(process.env.VALUER_MIN_PRICE_DEFAULT || '250')) / 2));
      const altMin = fallbackMin > 0 ? fallbackMin : 100;
      console.log(`No lots found. Retrying batch with reduced minPrice=${altMin}`);
      const fallbackQueries = (allExecutedQueries.length > 0 ? allExecutedQueries : selected);
      const fallbackSearches = fallbackQueries.map(q => ({ query: q, priceResult: { min: String(altMin) }, limit: perQueryLimit, sort }));
      const t1 = Date.now();
      const batch2 = await valuer.batchSearch({
        searches: fallbackSearches,
        concurrency,
        // Fetch ONLY the first page per query
        fetchAllPages: false
      }, {
        timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : Number(process.env.VALUER_BATCH_HTTP_TIMEOUT_MS || 0) || undefined,
        retry: typeof retries === 'number' ? { attempts: retries } : undefined,
      });
      console.log(`Fallback batch completed in ${Date.now() - t1}ms with ${batch2?.searches?.length || 0} segments`);
      for (const s of batch2.searches || []) {
        const lots = s?.result?.data?.lots || [];
        const meta = { query: s?.query || '', lotsCount: Array.isArray(lots) ? lots.length : 0, error: s?.error || undefined };
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
          if (aggregated.length >= MAX_ITEMS_TOTAL) break;
        }
        if (aggregated.length >= MAX_ITEMS_TOTAL) break;
        byQuery.push({ ...s, meta });
      }
    } catch (e) {
      console.warn('Fallback batch failed:', (e as Error)?.message || e);
    }
  }

  // Optional category filtering to reduce cross-domain drift
  const isFineArt = String(category || '').toLowerCase() === 'fine_art';
  if (isFineArt && aggregated.length) {
    const fineArtPattern = /(paint|oil|acrylic|canvas|panel|watercolor|gouache|tempera|lithograph|etch(ing)?|engraving|drawing|print)/i;
    const bannedPattern = /(coin|dukat|ducat|solidus|brooch|ring|jewelry|jewel|armor|samurai|pen\b|nautilus|shell|diamond|lapis|925\b|silver|gold|map|rookie card)/i;
    const filtered = aggregated.filter((lot) => {
      const title = String(lot?.title || '').toLowerCase();
      if (!title) return false;
      if (bannedPattern.test(title)) return false;
      return fineArtPattern.test(title);
    });
    if (filtered.length > 0) {
      console.log(`Applied fine_art filter: reduced lots from ${aggregated.length} to ${filtered.length}`);
      aggregated = filtered;
    }
  }

  // Optional summarization with GPT-5
  let summary: { minValue: number; maxValue: number; mostLikelyValue: number; comparableItems: CompactItem[] } | null = null;
  const forceSkipEnv = String(process.env.VALUER_FORCE_SKIP_SUMMARY || '').toLowerCase();
  const forceSkip = ['1','true','yes','on'].includes(forceSkipEnv);
  const doSummarize = !skipSummary && !forceSkip;
  if (doSummarize) {
    try {
      const itemsJson = JSON.stringify(aggregated.slice(0, 60));
      const summaryPrompt = (() => {
        if (justifyMode && typeof targetValue === 'number' && isFinite(targetValue)) {
          return [
            'You are a valuation assistant. Given comparable auction items and a target appraiser value, assess support for that value.',
            'Return ONLY JSON with keys: minValue, maxValue, mostLikelyValue, supportLevel ("strong"|"moderate"|"weak"),',
            'and comparableItems (top 10, same shape as below). Do not include any commentary outside JSON.',
            '{ "minValue": number, "maxValue": number, "mostLikelyValue": number, "supportLevel": string, "comparableItems": [ { "title": string, "price": number | null, "currency": string | null, "auctionHouse": string | null, "date": string | null, "url": string | null } ] }',
            '',
            `Target Value: ${targetValue}`,
            `Items JSON: ${itemsJson}`
          ].join('\n');
        }
        return [
          'Given a JSON array of comparable auction items (title, optional price with currency, house, date, url),',
          'infer a reasonable minValue, maxValue, and mostLikelyValue (numbers).',
          'Select the 10 most relevant comparableItems. Return JSON strictly as:',
          '{ "minValue": number, "maxValue": number, "mostLikelyValue": number, "comparableItems": [ { "title": string, "price": number | null, "currency": string | null, "auctionHouse": string | null, "date": string | null, "url": string | null } ] }',
          '',
          `Items JSON: ${itemsJson}`
        ].join('\n');
      })();
      const parsed = await callOpenAIAndParseJson<any>(openai, {
        model: 'gpt-5',
        systemMessage: 'You are a valuation assistant. Output only valid JSON.',
        userPrompt: summaryPrompt,
        expectJsonResponse: true
      });
      if (parsed && typeof parsed === 'object') {
        const items = Array.isArray(parsed.comparableItems) ? parsed.comparableItems.slice(0, 10) : [];
        const baseSummary: any = {
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
        if (justifyMode) {
          baseSummary.targetValue = targetValue;
          if (typeof parsed.supportLevel === 'string') baseSummary.supportLevel = String(parsed.supportLevel);
        }
        summary = baseSummary as typeof summary;
      }
    } catch (e) {
      console.warn('Summarization via GPT-5 failed:', (e as Error)?.message || e);
    }
  }

  const totalLots = aggregated.length;
  const durationMs = Date.now() - tBatch0;
  res.json({
    success: true,
    generatedQueries: allExecutedQueries.length > 0 ? allExecutedQueries : selected,
    sources: { valuerBatch: true },
    data: {
      lots: aggregated,
      byQuery
    },
    stats: { ...cumulativeStats, uniqueLots: uniqueTitles.size, totalLots, durationMs },
    summary: summary || undefined
  });
}));

// v2: Structured batch search with explicit tiers and stable contract
const V2BatchSchema = z.object({
  schemaVersion: z.string().optional(),
  context: z.object({
    sessionId: z.string().optional(),
    appraisalId: z.string().optional(),
    target: z.enum(['professional', 'screener']).optional(),
    rev: z.string().optional(),
  }).optional(),
  pricing: z.object({
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    justify: z.boolean().optional(),
    reference: z.number().nullable().optional(),
  }).optional(),
  limits: z.object({
    perTerm: z.number().optional(),
    total: z.number().optional(),
    timeoutMs: z.number().optional(),
    retries: z.number().optional(),
  }).optional(),
  options: z.object({
    tierSplit: z.enum(['provided', 'ignore']).optional(),
    concurrency: z.number().optional(),
    sort: z.string().optional(),
  }).optional(),
  terms: z.object({
    very_specific: z.array(z.string()).optional(),
    specific: z.array(z.string()).optional(),
    moderate: z.array(z.string()).optional(),
    flattened: z.array(z.string()).optional(),
  })
});

app.post('/v2/search/batch', asyncHandler(async (req, res) => {
  const corrId = req.header('X-Correlation-Id') || undefined;
  const parsed = V2BatchSchema.parse(req.body);
  const schemaVersion = parsed.schemaVersion || '2.0';
  const ctx = parsed.context || {};
  const pricing = parsed.pricing || {};
  const limits = parsed.limits || {};
  const options = parsed.options || {};
  const terms = parsed.terms || {} as any;

  const concurrency = typeof options.concurrency === 'number' && options.concurrency > 0
    ? options.concurrency
    : Number(process.env.VALUER_BATCH_CONCURRENCY || 5);
  const limitPerQuery = typeof limits.perTerm === 'number' && limits.perTerm > 0 ? limits.perTerm : 100;
  const sort = options.sort || 'relevance';
  const timeoutMs = limits.timeoutMs;
  const retries = limits.retries;

  const envTimeout = Number(process.env.VALUER_BATCH_HTTP_TIMEOUT_MS);
  const resolvedTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined);

  const batchOptions: { timeoutMs?: number; retry?: { attempts: number } } = {};
  if (resolvedTimeoutMs !== undefined) {
    batchOptions.timeoutMs = resolvedTimeoutMs;
  }
  if (typeof retries === 'number' && Number.isFinite(retries) && retries > 0) {
    batchOptions.retry = { attempts: retries };
  }

  // Build tiers from provided terms (respect caller ordering)
  const vs = Array.isArray(terms.very_specific) ? Array.from(new Set(terms.very_specific.map(String).map(s=>s.trim()).filter(Boolean))) : [];
  const sp = Array.isArray(terms.specific) ? Array.from(new Set(terms.specific.map(String).map(s=>s.trim()).filter(Boolean))) : [];
  const md = Array.isArray(terms.moderate) ? Array.from(new Set(terms.moderate.map(String).map(s=>s.trim()).filter(Boolean))) : [];
  const flattened = Array.isArray(terms.flattened) ? terms.flattened : [...vs, ...sp, ...md];
  if (flattened.length === 0) {
    return res.status(400).json({ success: false, error: 'terms_required', message: 'Provide non-empty terms. (v2)' });
  }

  const acceptedPlan = {
    very_specific: vs.length,
    specific: sp.length,
    moderate: md.length,
    total: flattened.length,
  };

  try {
    console.log('Tier plan (provided v2):', acceptedPlan);
  } catch (_) {}

  // Pricing band: v2 expects WS to compute min/max; do not derive from target here.
  const effMinPrice = (typeof pricing.min === 'number' && isFinite(pricing.min as number))
    ? (pricing.min as number)
    : Number(process.env.VALUER_MIN_PRICE_DEFAULT || 250);
  const effMaxPrice = (typeof pricing.max === 'number' && isFinite(pricing.max as number)) ? (pricing.max as number) : undefined;
  const justify = Boolean(pricing.justify);

  // Execute as a single combined batch across all tiers (respect provided plan)
  {
    type TermWithTier = { term: string; tier: string };
    const combined: TermWithTier[] = [];
    const vs = Array.isArray(terms.very_specific) ? Array.from(new Set(terms.very_specific.map(String).map(s=>s.trim()).filter(Boolean))) : [];
    const sp = Array.isArray(terms.specific) ? Array.from(new Set(terms.specific.map(String).map(s=>s.trim()).filter(Boolean))) : [];
    const md = Array.isArray(terms.moderate) ? Array.from(new Set(terms.moderate.map(String).map(s=>s.trim()).filter(Boolean))) : [];
    const flattened = Array.isArray(terms.flattened) ? terms.flattened : [...vs, ...sp, ...md];
    vs.forEach(t => combined.push({ term: t, tier: 'very specific' }));
    sp.forEach(t => combined.push({ term: t, tier: 'specific' }));
    md.forEach(t => combined.push({ term: t, tier: 'moderate' }));
    if (combined.length === 0) {
      flattened.forEach(t => combined.push({ term: t, tier: 'provided' }));
    }

    if (typeof limits.total === 'number' && isFinite(limits.total) && limits.total !== combined.length) {
      try { console.log(`Note: limits.total=${limits.total} != providedTerms=${combined.length}. Proceeding with provided terms to honor plan.`); } catch (_) {}
    }

    const uniqueTitles2 = new Set<string>();
    let aggregated2: Array<{ title?: string; price?: { amount?: number; currency?: string }; auctionHouse?: string; date?: string; url?: string }> = [];
    const byQuery2: any[] = [];
    const allExecuted2: Array<{ term: string; tier: string }> = [];
    const tStart2 = Date.now();

    const searches = combined.map(({ term, tier }) => {
      const priceResult: any = { min: String(effMinPrice) };
      if (typeof effMaxPrice === 'number') priceResult.max = String(effMaxPrice);
      allExecuted2.push({ term, tier });
      return ({ query: term, priceResult, limit: limitPerQuery, sort });
    });

    const t0 = Date.now();
    const batch = await valuer.batchSearch({
      searches,
      concurrency: Math.min(concurrency, searches.length),
      fetchAllPages: false
    }, batchOptions);
    const batchDuration = Date.now() - t0;
    console.log(`Batch search completed: total=${batch?.batch?.total || searches.length}, completed=${batch?.batch?.completed || 0}, failed=${batch?.batch?.failed || 0}, concurrency=${Math.min(concurrency, searches.length)}, durationMs=${batchDuration}`);

    for (let i = 0; i < (batch.searches || []).length; i++) {
      const s = (batch.searches || [])[i];
      const lots = s?.result?.data?.lots || [];
      const meta = { query: s?.query || combined[i]?.term || '', lotsCount: Array.isArray(lots) ? lots.length : 0, tier: combined[i]?.tier };
      byQuery2.push({ ...s, meta });
      for (const lot of lots) {
        const rawTitle = lot?.title || lot?.lotTitle;
        if (typeof rawTitle !== 'string' || rawTitle.length === 0) continue;
        const title = rawTitle;
        if (uniqueTitles2.has(title)) continue;
        uniqueTitles2.add(title);
        const priceAmount = (lot?.price && typeof lot.price.amount === 'number') ? lot.price.amount : (typeof lot?.priceResult === 'number' ? lot.priceResult : undefined);
        const currency = lot?.price?.currency || lot?.currency || lot?.currencyCode || 'USD';
        aggregated2.push({
          title,
          price: priceAmount ? { amount: priceAmount, currency } : undefined,
          auctionHouse: lot?.auctionHouse || lot?.house || lot?.houseName,
          date: lot?.date || lot?.dateTimeLocal,
          url: lot?.url || lot?.lotUrl
        });
      }
    }

    const durationMs2 = Date.now() - tStart2;
    const summary2 = { totalItems: aggregated2.length, uniqueLots: uniqueTitles2.size, durationMs: durationMs2 };
    const acceptedPlan = {
      very_specific: vs.length,
      specific: sp.length,
      moderate: md.length,
      total: (Array.isArray(terms.flattened) ? terms.flattened.length : (vs.length + sp.length + md.length)),
    };

    return res.json({
      success: true,
      correlationId: corrId || null,
      acceptedPlan,
      used: { queries: allExecuted2, pricing: { min: effMinPrice, max: effMaxPrice || null, reference: (pricing as any).reference ?? null, justify } },
      data: { byQuery: byQuery2 },
      batch: batch?.batch || { total: searches.length, completed: (batch?.searches || []).length, failed: 0 },
      summary: summary2,
      meta: { schemaVersion, context: ctx }
    });
  }

  // Apply total cap across tiers
  const totalLimit = (typeof limits.total === 'number' && Number.isFinite(limits.total)) ? limits.total : undefined;
  let remaining = Infinity;
  if (typeof totalLimit === 'number') {
    remaining = Math.max(0, Math.floor(totalLimit));
  }
  type Tier = { name: string; terms: string[] };
  const tiers: Tier[] = [];
  if (vs.length) tiers.push({ name: 'very specific', terms: vs });
  if (sp.length) tiers.push({ name: 'specific', terms: sp });
  if (md.length) tiers.push({ name: 'moderate', terms: md });
  if (tiers.length === 0) {
    // Fallback to single-tier execution over flattened
    tiers.push({ name: 'provided', terms: flattened });
  }

  const uniqueTitles = new Set<string>();
  let aggregated: Array<{ title?: string; price?: { amount?: number; currency?: string }; auctionHouse?: string; date?: string; url?: string }> = [];
  const byQuery: any[] = [];
  const allExecuted: Array<{ term: string; tier: string }> = [];
  let batchTotals = { total: 0, completed: 0, failed: 0 };
  const tStart = Date.now();

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (remaining <= 0) break;
    const clean = tier.terms.filter(Boolean);
    const tiersLeft = (tiers.length - i);
    const spread = Math.ceil((isFinite(remaining) ? remaining : clean.length) / Math.max(1, tiersLeft));
    const desiredForTier = Math.max(concurrency, spread);
    const takeCount = Math.min(isFinite(remaining) ? remaining : clean.length, Math.min(desiredForTier, clean.length));
    const tierTerms = clean.slice(0, takeCount);
    if (tierTerms.length === 0) continue;

    try { console.log(`Executing tier "${tier.name}" queries: ${tierTerms.join(' | ')}`); } catch (_) {}

    const searchesTier = tierTerms.map(q => {
      const priceResult: any = { min: String(effMinPrice) };
      if (typeof effMaxPrice === 'number') priceResult.max = String(effMaxPrice);
      allExecuted.push({ term: q, tier: tier.name });
      return ({ query: q, priceResult, limit: limitPerQuery, sort });
    });

    const t0 = Date.now();
    const batchTier = await valuer.batchSearch({
      searches: searchesTier,
      concurrency: Math.min(concurrency, searchesTier.length),
      fetchAllPages: false
    }, batchOptions);
    const tierDuration = Date.now() - t0;
    console.log(`Batch search completed: total=${batchTier?.batch?.total || searchesTier.length}, completed=${batchTier?.batch?.completed || 0}, failed=${batchTier?.batch?.failed || 0}, concurrency=${Math.min(concurrency, searchesTier.length)}, durationMs=${tierDuration}`);
    batchTotals.total += batchTier?.batch?.total || searchesTier.length;
    batchTotals.completed += batchTier?.batch?.completed || 0;
    batchTotals.failed += batchTier?.batch?.failed || 0;

    remaining = isFinite(remaining) ? Math.max(0, remaining - tierTerms.length) : remaining;

    for (const s of batchTier.searches || []) {
      const lots = s?.result?.data?.lots || [];
      const meta = { query: s?.query || '', lotsCount: Array.isArray(lots) ? lots.length : 0 };
      byQuery.push({ ...s, meta });
      for (const lot of lots) {
        const rawTitle = lot?.title || lot?.lotTitle;
        if (typeof rawTitle !== 'string' || rawTitle.length === 0) continue;
        const title = rawTitle;
        if (uniqueTitles.has(title)) continue;
        uniqueTitles.add(title);
        const priceAmount = (lot?.price && typeof lot.price.amount === 'number') ? lot.price.amount : (typeof lot?.priceResult === 'number' ? lot.priceResult : undefined);
        const currency = lot?.price?.currency || lot?.currency || lot?.currencyCode || 'USD';
        aggregated.push({
          title,
          price: priceAmount ? { amount: priceAmount, currency } : undefined,
          auctionHouse: lot?.auctionHouse || lot?.house || lot?.houseName,
          date: lot?.date || lot?.dateTimeLocal,
          url: lot?.url || lot?.lotUrl
        });
      }
    }
  }

  const durationMs = Date.now() - tStart;
  const summary = { totalItems: aggregated.length, uniqueLots: uniqueTitles.size, durationMs };

  return res.json({
    success: true,
    correlationId: corrId || null,
    acceptedPlan,
    used: { queries: allExecuted, pricing: { min: effMinPrice, max: effMaxPrice || null, justify } },
    data: { byQuery },
    batch: batchTotals,
    summary,
    meta: { schemaVersion, context: ctx }
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
