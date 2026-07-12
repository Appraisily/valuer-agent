import express, { Request, Response, NextFunction } from 'express';
import type { RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ValuerService } from './services/valuer.js';
import { archiveJSON, storageEnabled } from './services/utils/local-storage.js';
import { messagingEnabled, publishEvent, closeBroker } from './services/utils/messaging.js';
import { CONTRACT_VERSIONS } from '@appraisily/auction-contracts';

type CompactLot = {
  id?: string;
  lot_uid?: string;
  lotRef?: string;
  lot_ref?: string;
  lotId?: string;
  title?: string;
  price?: { amount?: number; currency?: string | null; symbol?: string | null };
  auctionHouse?: string;
  date?: string;
  url?: string;
  lotUrl?: string;
  lot_url?: string;
  sourceUrl?: string;
  source_url?: string;
  thumbUrl?: string;
  imageUrl?: string;
  originalUrl?: string;
  imageOriginalUrl?: string;
  imagePath?: string;
  imageFileName?: string;
};

type TermWithTier = { term: string; tier: string };
type CurrencyComparabilityStatus = 'single' | 'mixed' | 'unknown' | 'none';
type CurrencyComparabilitySummary = {
  status: CurrencyComparabilityStatus;
  valuesComparable: boolean;
  currency: string | null;
  currencies: string[];
  pricedLots: number;
  unknownCurrencyLots: number;
  note?: string;
};

const shouldArchiveResponses = String(process.env.VALUER_ARCHIVE_RESPONSES ?? process.env.SAVE_VALUER_RESPONSES ?? 'false').toLowerCase() === 'true';
const archivePrefix = process.env.VALUER_ARCHIVE_PREFIX ?? 'valuer-bridge/responses';
const eventRoutingKey = process.env.MESSAGE_ROUTING_KEY ?? 'valuer.http.completed';
const maxBatchTerms = intFromEnv('VALUER_BATCH_MAX_TERMS', 25);
const maxTermLength = intFromEnv('VALUER_BATCH_MAX_TERM_LENGTH', 160);

const valuer = new ValuerService();
const app = express();
const require = createRequire(import.meta.url);
type CorsModule = { createCorsMiddleware: (options?: Record<string, unknown>) => RequestHandler };
const { createCorsMiddleware } = require('../../_shared/cors') as CorsModule;
const corsMiddleware = createCorsMiddleware({ logger: console });

app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(express.json());

function safeClone<T>(input: T): T | undefined {
  if (input === null || typeof input === 'undefined') return input as T | undefined;
  try {
    return JSON.parse(JSON.stringify(input)) as T;
  } catch {
    return undefined;
  }
}

function comparableDedupeKey(lot: any, title: string): string {
  const lotUid = lot?.lot_uid || lot?.lotUid || lot?.id || lot?.lotId;
  if (lotUid) return `lot:${String(lotUid).trim()}`;
  const url = lot?.url || lot?.lotUrl || lot?.lot_url || lot?.sourceUrl || lot?.source_url || lot?.permalink;
  if (url) return `url:${String(url).trim().toLowerCase()}`;
  return `title:${String(title || '').trim().toLowerCase()}`;
}

function comparableImageFields(lot: any): Pick<CompactLot, 'thumbUrl' | 'imageUrl' | 'originalUrl' | 'imageOriginalUrl'> {
  const thumbUrl = lot?.thumbUrl || lot?.thumbnail || lot?.thumb || lot?.smallImage || lot?.imageUrl || lot?.image;
  const imageUrl = lot?.imageUrl || lot?.mediumUrl || lot?.image || thumbUrl;
  const originalUrl = lot?.originalUrl || lot?.imageOriginalUrl || lot?.fullUrl || imageUrl;
  return {
    thumbUrl: thumbUrl ? String(thumbUrl) : undefined,
    imageUrl: imageUrl ? String(imageUrl) : undefined,
    originalUrl: originalUrl ? String(originalUrl) : undefined,
    imageOriginalUrl: originalUrl ? String(originalUrl) : undefined,
  };
}

function uniqueTerms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map(String).map((term) => term.trim()).filter(Boolean)));
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (!trimmed || trimmed === 'UNKNOWN' || trimmed === 'N/A' || trimmed === 'NULL') return null;
  return trimmed;
}

function summarizeComparableCurrencies(lots: CompactLot[]): CurrencyComparabilitySummary {
  const currencies = new Set<string>();
  let pricedLots = 0;
  let unknownCurrencyLots = 0;

  for (const lot of lots) {
    const amount = lot?.price?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    pricedLots += 1;

    const currency = normalizeCurrencyCode(lot.price?.currency);
    if (currency) currencies.add(currency);
    else unknownCurrencyLots += 1;
  }

  const currencyList = Array.from(currencies).sort();
  if (pricedLots === 0) {
    return {
      status: 'none',
      valuesComparable: false,
      currency: null,
      currencies: [],
      pricedLots,
      unknownCurrencyLots,
      note: 'No priced comparables were returned.',
    };
  }

  if (currencyList.length === 1 && unknownCurrencyLots === 0) {
    return {
      status: 'single',
      valuesComparable: true,
      currency: currencyList[0],
      currencies: currencyList,
      pricedLots,
      unknownCurrencyLots,
    };
  }

  if (currencyList.length === 0) {
    return {
      status: 'unknown',
      valuesComparable: false,
      currency: null,
      currencies: [],
      pricedLots,
      unknownCurrencyLots,
      note: 'Comparable prices are present, but their currencies are unknown.',
    };
  }

  return {
    status: 'mixed',
    valuesComparable: false,
    currency: null,
    currencies: currencyList,
    pricedLots,
    unknownCurrencyLots,
    note: 'Comparable prices include multiple or missing currencies; convert or exclude before valuation math.',
  };
}

function intFromEnv(name: string, fallback: number, min = 1): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function buildSearches(combined: TermWithTier[], minPrice: number, maxPrice: number | undefined, limitPerTerm: number, sort: string) {
  return combined.map(({ term }) => {
    const priceResult: Record<string, string> = { min: String(minPrice) };
    if (typeof maxPrice === 'number') priceResult.max = String(maxPrice);
    return { query: term, priceResult, limit: limitPerTerm, sort };
  });
}

const TermArraySchema = z.array(z.string().trim().min(1).max(maxTermLength)).max(maxBatchTerms);

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
    very_specific: TermArraySchema.optional(),
    specific: TermArraySchema.optional(),
    moderate: TermArraySchema.optional(),
    flattened: TermArraySchema.optional(),
  }),
});

async function executeBatchSearch(parsed: z.infer<typeof V2BatchSchema>, correlationId?: string | null) {
  const schemaVersion = parsed.schemaVersion || '2.0';
  const context = parsed.context || {};
  const pricing = parsed.pricing || {};
  const limits = parsed.limits || {};
  const options = parsed.options || {};
  const terms = parsed.terms || {};

  const verySpecific = uniqueTerms(terms.very_specific);
  const specific = uniqueTerms(terms.specific);
  const moderate = uniqueTerms(terms.moderate);
  const flattened = uniqueTerms(terms.flattened);

  const combined: TermWithTier[] = [];
  verySpecific.forEach((term) => combined.push({ term, tier: 'very specific' }));
  specific.forEach((term) => combined.push({ term, tier: 'specific' }));
  moderate.forEach((term) => combined.push({ term, tier: 'moderate' }));
  if (combined.length === 0) {
    flattened.forEach((term) => combined.push({ term, tier: 'provided' }));
  }

  if (combined.length === 0) {
    const err = new Error('Provide non-empty terms. Valuer Bridge does not generate search terms.');
    (err as any).status = 400;
    (err as any).code = 'terms_required';
    throw err;
  }
  if (combined.length > maxBatchTerms) {
    const err = new Error(`Valuer Bridge accepts at most ${maxBatchTerms} search terms per request.`);
    (err as any).status = 400;
    (err as any).code = 'too_many_terms';
    throw err;
  }

  const acceptedPlan = {
    very_specific: verySpecific.length,
    specific: specific.length,
    moderate: moderate.length,
    total: flattened.length || combined.length,
  };

  const concurrency = Math.max(1, Math.min(
    10,
    Math.floor(numberOrUndefined(options.concurrency) || Number(process.env.VALUER_BATCH_CONCURRENCY || 5)),
  ));
  const limitPerTerm = Math.max(1, Math.min(200, Math.floor(numberOrUndefined(limits.perTerm) || 100)));
  const sort = options.sort || 'relevance';
  const minPrice = numberOrUndefined(pricing.min) ?? Number(process.env.VALUER_MIN_PRICE_DEFAULT || 250);
  const maxPrice = numberOrUndefined(pricing.max);
  const timeoutMs = numberOrUndefined(limits.timeoutMs) || numberOrUndefined(process.env.VALUER_BATCH_HTTP_TIMEOUT_MS);
  const retries = numberOrUndefined(limits.retries);
  const searches = buildSearches(combined, minPrice, maxPrice, limitPerTerm, sort);
  const tStart = Date.now();
  const skipThumbPublish = typeof context.rev === 'string'
    && (context.rev.startsWith('instant-appraisal') || context.rev.startsWith('appraisily-pro-mcp'));

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    context: 'VALUER_BATCH',
    msg: 'search:start',
    correlationId,
    acceptedPlan,
    concurrency: Math.min(concurrency, searches.length),
    limitPerTerm,
  }));

  const batch = await valuer.batchSearch({
    searches,
    concurrency: Math.min(concurrency, searches.length),
    fetchAllPages: false,
    skipThumbPublish,
  }, {
    timeoutMs,
    retry: retries && retries > 0 ? { attempts: retries } : undefined,
  });

  const uniqueComparableKeys = new Set<string>();
  const aggregated: CompactLot[] = [];
  const byQuery: any[] = [];

  for (let index = 0; index < (batch.searches || []).length; index += 1) {
    const search = (batch.searches || [])[index];
    const lots = Array.isArray(search?.result?.data?.lots) ? search.result.data.lots : [];
    const meta = {
      query: search?.query || combined[index]?.term || '',
      lotsCount: lots.length,
      tier: combined[index]?.tier,
      error: search?.error || undefined,
    };
    byQuery.push({ ...search, meta });

    for (const lot of lots) {
      const rawTitle = lot?.title || lot?.lotTitle;
      if (typeof rawTitle !== 'string' || rawTitle.length === 0) continue;
      const title = rawTitle;
      const dedupeKey = comparableDedupeKey(lot, title);
      if (uniqueComparableKeys.has(dedupeKey)) continue;
      uniqueComparableKeys.add(dedupeKey);

      const priceAmount = (lot?.price && typeof lot.price.amount === 'number')
        ? lot.price.amount
        : (typeof lot?.priceResult === 'number' ? lot.priceResult : undefined);
      const currency = lot?.price?.currency || lot?.currency || lot?.currencyCode || null;
      const symbol = lot?.price?.symbol || lot?.currencySymbol || null;
      const lotUid: string | undefined = lot?.lot_uid || lot?.lotUid || lot?.id || lot?.lotId;
      const lotRef: string | undefined = lot?.lotRef || lot?.lot_ref;
      const sourceUrl = lot?.url || lot?.lotUrl || lot?.lot_url || lot?.sourceUrl || lot?.source_url;

      aggregated.push({
        id: lotUid ? String(lotUid) : undefined,
        lot_uid: lotUid ? String(lotUid) : undefined,
        lotRef: lotRef ? String(lotRef) : undefined,
        lot_ref: lotRef ? String(lotRef) : undefined,
        lotId: lotUid ? String(lotUid) : undefined,
        title,
        price: typeof priceAmount === 'number' && Number.isFinite(priceAmount) ? { amount: priceAmount, currency, symbol } : undefined,
        auctionHouse: lot?.auctionHouse || lot?.house || lot?.houseName,
        date: lot?.date || lot?.dateTimeLocal || lot?.auctionDate,
        url: sourceUrl,
        lotUrl: sourceUrl,
        lot_url: sourceUrl,
        sourceUrl,
        source_url: sourceUrl,
        ...comparableImageFields(lot),
        imagePath: lot?.imagePath ? String(lot.imagePath) : undefined,
        imageFileName: lot?.imageFileName ? String(lot.imageFileName) : undefined,
      });
    }
  }

  const durationMs = Date.now() - tStart;
  return {
    success: true,
    correlationId: correlationId || null,
    acceptedPlan,
    used: {
      queries: combined,
      pricing: {
        min: minPrice,
        max: maxPrice ?? null,
        reference: pricing.reference ?? null,
        justify: Boolean(pricing.justify),
      },
    },
    data: {
      lots: aggregated,
      byQuery,
    },
    batch: batch?.batch || { total: searches.length, completed: (batch?.searches || []).length, failed: 0 },
    summary: {
      totalItems: aggregated.length,
      uniqueLots: uniqueComparableKeys.size,
      currency: summarizeComparableCurrencies(aggregated),
      durationMs,
    },
    meta: { schemaVersion, context },
  };
}

function legacyGone(endpoint: string, replacement = '/v2/search/batch') {
  return (_req: Request, res: Response) => {
    res.set('Link', `<${replacement}>; rel="alternate"`);
    return res.status(410).json({
      success: false,
      error: 'endpoint_removed',
      endpoint,
      replacement,
      message: `${endpoint} has been removed. Valuer Bridge only serves caller-supplied DB searches through ${replacement}.`,
    });
  };
}

function installRequestLogging() {
  app.use((req: Request, res: Response, next: NextFunction) => {
    try {
      const start = Date.now();
      const inbound = req.header('X-Correlation-Id') || req.header('X-Request-Id');
      const requestId = inbound || (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
      try { res.setHeader('x-request-id', requestId); } catch {}
      (res.locals as Record<string, unknown>).requestId = requestId;
      const capturedBody = typeof req.body === 'object' && req.body !== null ? safeClone(req.body) : req.body;

      const originalJson = res.json.bind(res);
      res.json = ((body: any) => {
        (res.locals as Record<string, unknown>).responseBody = body;
        return originalJson(body);
      }) as typeof res.json;

      const meta: Record<string, unknown> = {
        requestId,
        correlationId: requestId,
        method: req.method,
        url: req.originalUrl,
        ip: (req as any).ip,
        userAgent: req.get('user-agent') || '',
      };

      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', context: 'HTTP', msg: 'request:start', ...meta }));
      res.on('finish', () => {
        const summary = {
          ...meta,
          status: res.statusCode,
          durationMs: Date.now() - start,
          timestamp: new Date().toISOString(),
        };
        console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', context: 'HTTP', msg: 'request:end', ...summary }));

        if (messagingEnabled) {
          publishEvent(eventRoutingKey, summary, {
            'x-request-id': String(requestId),
            'x-service': 'valuer-bridge',
          }).catch((err: unknown) => {
            console.warn('[valuer-bridge] Failed to publish request event:', (err as Error)?.message ?? err);
          });
        }

        if (shouldArchiveResponses && storageEnabled) {
          archiveJSON(archivePrefix, {
            ...summary,
            request: { query: req.query, body: capturedBody },
            response: (res.locals as Record<string, unknown>).responseBody,
          }).catch((err: unknown) => {
            console.warn('[valuer-bridge] Failed to archive response payload:', (err as Error)?.message ?? err);
          });
        }
      });
    } catch {}
    next();
  });
}

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'valuer-bridge',
    auctionContracts: CONTRACT_VERSIONS,
    ...valuer.getReadiness(),
  });
});

installRequestLogging();

app.post('/v2/search/batch', asyncHandler(async (req, res) => {
  const parsed = V2BatchSchema.parse(req.body);
  const result = await executeBatchSearch(parsed, req.header('X-Correlation-Id'));
  res.json(result);
}));

for (const endpoint of [
  '/api/justify',
  '/api/find-value',
  '/api/find-value-range',
  '/api/auction-results',
  '/api/wp2hugo-auction-results',
  '/api/multi-search',
  '/api/enhanced-statistics',
]) {
  app.post(endpoint, legacyGone(endpoint));
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error(`Error processing request ${req.method} ${req.path}:`, err);

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'malformed_json',
      message: 'Your request contains invalid JSON syntax.',
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: 'invalid_request_body',
      details: err.errors,
    });
  }

  const statusCode = (err as any).status || 500;
  const error = (err as any).code || err.message || 'internal_server_error';
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
    success: false,
    error,
    message: err.message || 'Internal Server Error',
  });
});

const port = process.env.PORT || 8080;

async function gracefulShutdown(signal: string) {
  console.log(`[valuer-bridge] Received ${signal}, shutting down gracefully...`);
  try {
    await closeBroker();
    await valuer.close();
  } catch (err) {
    console.warn('[valuer-bridge] Error during shutdown:', (err as Error)?.message ?? err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

function isDirectRun() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}

if (isDirectRun()) {
  app.listen(port, () => {
    console.log(`Valuer Bridge listening on port ${port} with scraper_db provider`);
  });
}

export { app, executeBatchSearch, summarizeComparableCurrencies };
