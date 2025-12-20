import { ValuerResponse, ValuerLot } from './types.js';
import { ScraperDbClient, buildPublicAssetUrl } from './scraper-db.js';

// Helper to detect Cloud Run/metadata server availability for ID token fetching
async function fetchIdentityToken(audienceUrl: string): Promise<string | null> {
  // Prefer explicitly provided token (useful for local dev or CI)
  if (process.env.VALUER_ID_TOKEN && process.env.VALUER_ID_TOKEN.trim().length > 0) {
    return process.env.VALUER_ID_TOKEN.trim();
  }

  // Attempt to fetch from GCP metadata server when running on Cloud Run/GCE/GKE
  try {
    const metadataUrl = `http://metadata/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audienceUrl)}&format=full`;
    const res = await fetch(metadataUrl, { headers: { 'Metadata-Flavor': 'Google' } as any });
    if (res.ok) {
      const token = await res.text();
      return token || null;
    }
  } catch (_err) {
    // Ignore – not in GCP environment or metadata server not reachable
  }
  return null;
}

type RetryableStatus = 429 | 502 | 503 | 504;

interface RetryConfig {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  input: string,
  init: RequestInit,
  retry?: Partial<RetryConfig>,
  timeoutMs?: number,
): Promise<Response> {
  const cfg: RetryConfig = {
    // Built-in sane defaults prefer code defaults over envs to avoid flags
    attempts: Math.max(1, Number(retry?.attempts ?? process.env.VALUER_RETRY_ATTEMPTS ?? 2)),
    baseDelayMs: Math.max(100, Number(retry?.baseDelayMs ?? process.env.VALUER_RETRY_BASE_MS ?? 500)),
    maxDelayMs: Math.max(500, Number(retry?.maxDelayMs ?? process.env.VALUER_RETRY_MAX_MS ?? 3000)),
  };

  let lastError: any;
  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    try {
      // Apply per-request timeout via AbortController
      const controller = new AbortController();
      const effectiveTimeout = (() => {
        if (typeof timeoutMs === 'number' && timeoutMs > 0) return timeoutMs;
        const envMs = Number(process.env.VALUER_HTTP_TIMEOUT_MS);
        if (!Number.isNaN(envMs) && envMs > 0) return envMs;
        return 90_000; // default 90s without flags
      })();
      const id = setTimeout(() => controller.abort(new Error('Request timed out')), effectiveTimeout);
      const res = await fetch(input, { ...init, signal: controller.signal });
      clearTimeout(id);
      if (res.ok) return res;
      const status = res.status as RetryableStatus | number;
      // Retry only on transient statuses
      if (status === 429 || status === 502 || status === 503 || status === 504) {
        lastError = new Error(`HTTP ${status}`);
      } else {
        return res; // non-retryable
      }
    } catch (err: any) {
      // Network-level errors: retry
      lastError = err;
    }

    if (attempt < cfg.attempts) {
      const jitter = Math.random() * 0.25 + 0.75; // 0.75x - 1x
      const delay = Math.min(cfg.maxDelayMs, Math.floor(cfg.baseDelayMs * Math.pow(2, attempt - 1) * jitter));
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Define the structure for a transformed hit
interface ValuerHit {
  lotTitle: string;
  priceResult: number;
  currencyCode: string;
  currencySymbol: string;
  houseName: string;
  dateTimeLocal: string;
  lotNumber: string;
  saleType: string;
  lotDescription?: string; // Added optional description
}

// Update ValuerSearchResponse to use the ValuerHit interface
export interface ValuerSearchResponse {
  hits: ValuerHit[];
}

// Helper function to transform ValuerLot to ValuerHit
function transformValuerLotToHit(lot: ValuerLot): ValuerHit {
  return {
    lotTitle: lot.title,
    priceResult: lot.price.amount,
    currencyCode: lot.price.currency,
    currencySymbol: lot.price.symbol,
    houseName: lot.auctionHouse,
    dateTimeLocal: lot.date,
    lotNumber: lot.lotNumber,
    saleType: lot.saleType,
    lotDescription: lot.description || ''
  };
}

export class ValuerService {
  private baseUrl: string;

  private audienceOrigin: string;
  private cachedAuthHeader: { Authorization: string } | null = null;
  private authEnabled: boolean;
  private scraperDb: ScraperDbClient | null = null;

  private async publishLotThumbs(lotUids: string[]): Promise<Map<string, { thumbUrl: string | null; srcPath: string | null }>> {
    const publishUrl = String(process.env.SCRAPPER_THUMBS_PUBLISH_URL || '').trim();
    const apiKey = String(process.env.SCRAPPER_INTERNAL_API_KEY || '').trim();
    if (!publishUrl || !apiKey) return new Map();

    const limit = (() => {
      const raw = process.env.SCRAPER_DB_PUBLISH_THUMBS_LIMIT;
      const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
      if (!Number.isFinite(n) || n <= 0) return 12;
      return Math.max(1, Math.min(100, Math.floor(n)));
    })();

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const uid of lotUids) {
      const s = String(uid || '').trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      unique.push(s);
      if (unique.length >= limit) break;
    }
    if (!unique.length) return new Map();

    const controller = new AbortController();
    const timeoutMs = (() => {
      const env = Number(process.env.SCRAPPER_THUMBS_PUBLISH_TIMEOUT_MS);
      if (Number.isFinite(env) && env > 0) return Math.floor(env);
      return 60_000;
    })();
    const id = setTimeout(() => controller.abort(new Error('thumb_publish_timeout')), timeoutMs);

    try {
      const res = await fetch(publishUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        } as any,
        body: JSON.stringify({ lotUids: unique, limit: unique.length }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[valuer-agent] Thumb publish failed (${res.status}): ${text.slice(0, 300)}`);
        return new Map();
      }
      const json: any = await res.json().catch(() => null);
      const published = Array.isArray(json?.published) ? json.published : [];
      const out = new Map<string, { thumbUrl: string | null; srcPath: string | null }>();
      for (const item of published) {
        const lotUid = String(item?.lotUid || '').trim();
        if (!lotUid) continue;
        out.set(lotUid, {
          thumbUrl: item?.thumbUrl ? String(item.thumbUrl) : null,
          srcPath: item?.srcPath ? String(item.srcPath) : null,
        });
      }
      return out;
    } catch (err: any) {
      console.warn(`[valuer-agent] Thumb publish request error: ${err?.message || err}`);
      return new Map();
    } finally {
      clearTimeout(id);
    }
  }

  constructor() {
    const envBase = process.env.VALUER_BASE_URL || 'http://valuer:8080/api/search';
    this.baseUrl = envBase.replace(/\/?$/, '');
    const parsed = new URL(this.baseUrl);
    this.audienceOrigin = `${parsed.protocol}//${parsed.host}`;
    const hostname = parsed.hostname.toLowerCase();
    const isLocalHost = ['localhost', '127.0.0.1', 'valuer', 'valuer-dev', 'host.docker.internal'].includes(hostname);
    const disableAuth = String(process.env.VALUER_AUTH_DISABLED ?? (isLocalHost ? 'true' : 'false')).toLowerCase() === 'true';
    this.authEnabled = !disableAuth;
  }

  private resolveProvider(): 'live' | 'scraper_db' | 'auto' {
    const raw = String(process.env.VALUER_PROVIDER || process.env.VALUER_DATA_PROVIDER || 'live').toLowerCase().trim();
    if (raw === 'scraper' || raw === 'scraperdb' || raw === 'scraper_db' || raw === 'db') return 'scraper_db';
    if (raw === 'auto') return 'auto';
    return 'live';
  }

  private getScraperDb(): ScraperDbClient {
    if (this.scraperDb) return this.scraperDb;
    this.scraperDb = new ScraperDbClient();
    return this.scraperDb;
  }

  /**
   * Build Invaluable cookie objects from env when available.
   * Supports multiple env names to ease deployment.
   */
  private getInvaluableCookies(): Array<{ name: string; value: string; domain?: string; path?: string }> {
    try {
      // Allow passing full cookies JSON via VALUER_COOKIES or INVALUABLE_COOKIES
      const raw = process.env.VALUER_COOKIES || process.env.INVALUABLE_COOKIES;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as Array<{ name: string; value: string; domain?: string; path?: string }>;
      }
    } catch (_) {}

    const az = process.env.INVALUABLE_AZTOKEN_PROD || process.env.AZTOKEN_PROD || process.env.INVALUABLE_ACT_TOKEN || '';
    const cf = process.env.INVALUABLE_CF_CLEARANCE || process.env.CF_CLEARANCE || '';
    const cookies: Array<{ name: string; value: string; domain?: string; path?: string }> = [];
    if (az) cookies.push({ name: 'AZTOKEN-PROD', value: az, domain: '.invaluable.com', path: '/' });
    if (cf) cookies.push({ name: 'cf_clearance', value: cf, domain: '.invaluable.com', path: '/' });
    return cookies;
  }

  /**
   * Executes multiple searches in a single request via Valuer batch endpoint.
   * Returns hits per query in the same ValuerHit shape used by single search.
   */
  async multiSearch(
    inputs: Array<{ query: string; minPrice?: number; maxPrice?: number; limit?: number }>,
    options?: { timeoutMs?: number; retry?: Partial<RetryConfig> }
  ): Promise<Array<{ query: string; hits: ValuerHit[] }>> {
    const body: any = {
      searches: inputs.map((q) => {
        const params: any = { query: q.query, sort: 'relevance' };
        if (q.limit !== undefined) params.limit = q.limit;
        if (q.minPrice !== undefined || q.maxPrice !== undefined) {
          params.priceResult = {} as any;
          if (q.minPrice !== undefined) params.priceResult.min = String(q.minPrice);
          if (q.maxPrice !== undefined) params.priceResult.max = String(q.maxPrice);
        }
        return params;
      }),
      fetchAllPages: false,
      saveToGcs: false,
      concurrency: Math.max(1, Number(process.env.VALUER_BATCH_CONCURRENCY || 3)),
    };

    const res = await this.batchSearch(body, options);
    const results: Array<{ query: string; hits: ValuerHit[] }> = [];
    const arr = Array.isArray(res?.searches) ? res.searches : [];

    for (const item of arr) {
      try {
        if (item && !item.error && item.result?.data?.lots) {
          const lots = Array.isArray(item.result.data.lots) ? item.result.data.lots : [];
          const hits: ValuerHit[] = lots
            .map((lot: any) => ({
              lotTitle: lot.title,
              priceResult: lot?.price?.amount,
              currencyCode: lot?.price?.currency,
              currencySymbol: lot?.price?.symbol,
              houseName: lot.auctionHouse,
              dateTimeLocal: lot.date,
              lotNumber: lot.lotNumber,
              saleType: lot.saleType,
              lotDescription: lot.description || ''
            }))
            .filter((h: ValuerHit) => Boolean(h.lotTitle && h.priceResult));
          results.push({ query: item.query || '', hits });
        } else {
          results.push({ query: item?.query || '', hits: [] });
        }
      } catch (_err) {
        results.push({ query: item?.query || '', hits: [] });
      }
    }

    return results;
  }

  private async getAuthHeader(): Promise<Record<string, string>> {
    // If explicitly disabled, skip auth header
    if (!this.authEnabled || process.env.VALUER_AUTH_DISABLED === 'true') {
      return {};
    }

    // Cache token for the process lifetime to avoid repeated metadata calls
    if (this.cachedAuthHeader) {
      return this.cachedAuthHeader;
    }

    const token = await fetchIdentityToken(this.audienceOrigin);
    if (token) {
      this.cachedAuthHeader = { Authorization: `Bearer ${token}` };
      return this.cachedAuthHeader;
    }
    // No token available; return empty headers (works if the service allows unauthenticated)
    return {};
  }

  /**
   * Core search function to fetch results from the Valuer API.
   * Focuses on executing a single search request.
   * @param query Search query string
   * @param minPrice Optional minimum price filter
   * @param maxPrice Optional maximum price filter
   * @param limit Optional limit for the number of results from the API
   * @returns Promise with the raw search results (hits)
   */
  async search(query: string, minPrice?: number, maxPrice?: number, limit?: number, options?: { timeoutMs?: number; retry?: Partial<RetryConfig> }): Promise<ValuerSearchResponse> {
    const params = new URLSearchParams({
      query,
      ...(limit !== undefined && { 'limit': limit.toString() })
    });
    if (minPrice !== undefined || maxPrice !== undefined) {
      if (minPrice !== undefined) params.append('priceResult[min]', minPrice.toString());
      if (maxPrice !== undefined) params.append('priceResult[max]', maxPrice.toString());
    }

    // Add sorting by relevance
    params.append('sort', 'relevance');

    // If cookies are available via env, pass them along in the query for GET endpoint
    try {
      const cookies = this.getInvaluableCookies();
      if (cookies.length > 0) {
        params.append('cookies', JSON.stringify(cookies));
      }
    } catch (_) {}

    const url = `${this.baseUrl}?${params}`;
    console.log(`Executing valuer search: ${url}`);
    const authHeader = await this.getAuthHeader();
    const response = await fetchWithRetry(url, { headers: { ...authHeader } as any }, options?.retry, options?.timeoutMs);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Valuer service error:', errorBody);
      throw new Error(`Failed to fetch from Valuer service: ${response.statusText}`);
    }

    const data = await response.json() as ValuerResponse;
    const lots = Array.isArray(data?.data?.lots) ? data.data.lots : [];

    // Use the helper function for transformation
    const hits = lots.map(transformValuerLotToHit);

    console.log(`Valuer service raw response for query "${query}" (found ${hits.length} hits):
      First 10 titles: ${hits.slice(0, 10).map(h => h.lotTitle).join(', ')}`);

    if (hits.length === 0) {
      console.log('No results found for query:', query);
      // console.log('Raw response:', JSON.stringify(data, null, 2)); // Optionally log full raw response on no results
    }

    return { hits };
  }

  /**
   * Finds valuable auction results for a given keyword, potentially refining the search.
   * Handles retrying with a simpler keyword if initial results are insufficient.
   * @param keyword User search keyword
   * @param minPrice Minimum price to filter results (default: 1000)
   * @param limit Maximum number of results to return *after* merging and sorting (default: 10)
   * @returns Promise with auction results matching the criteria, sorted and limited.
   */
  async findValuableResults(keyword: string, minPrice: number = 1000, limit: number = 10, options?: { timeoutMs?: number; retry?: Partial<RetryConfig> }): Promise<ValuerSearchResponse> {
    // Initial search with the original keyword and a potentially larger internal limit
    // Fetch more initially (e.g., limit * 2) to allow for better merging/filtering later
    const initialLimit = limit * 2;
    let results = await this.search(keyword, minPrice, undefined, initialLimit, options);
    const allHits = [...results.hits];
    const seenTitles = new Set(allHits.map(hit => hit.lotTitle));

    // If not enough results, try with a more focused search by removing some words
    if (allHits.length < limit) {
      const keywords = keyword.split(' ');
      if (keywords.length > 1) {
        const significantKeywords = keywords
          .filter(word => !['antique', 'vintage', 'old', 'the', 'a', 'an'].includes(word.toLowerCase()))
          .slice(0, 3) // Use up to 3 significant keywords
          .join(' ');

        if (significantKeywords && significantKeywords !== keyword) {
          console.log(`Initial search for "${keyword}" yielded ${allHits.length} results (less than limit ${limit}). Retrying with "${significantKeywords}"`);
          // Fetch remaining needed results with the refined query
          const remainingLimit = initialLimit - allHits.length;
          const additionalResults = await this.search(significantKeywords, minPrice, undefined, remainingLimit > 0 ? remainingLimit : undefined, options);

          // Merge results, removing duplicates by title
          additionalResults.hits.forEach(hit => {
            if (!seenTitles.has(hit.lotTitle)) {
              allHits.push(hit);
              seenTitles.add(hit.lotTitle);
            }
          });
          console.log(`Found ${additionalResults.hits.length} additional results. Total unique hits: ${allHits.length}`);
        }
      }
    }

    // Sort all collected hits by price (highest first) and apply the final limit
    allHits.sort((a, b) => b.priceResult - a.priceResult);
    const finalHits = allHits.slice(0, limit);

    console.log(`Returning ${finalHits.length} final results for "${keyword}" after sorting and limiting.`);

    return { hits: finalHits };
  }

  /**
   * Finds items similar to a description within a specific price range.
   * @param description Item description used as search query
   * @param targetValue Optional target value to define price range
   * @returns Promise with auction results within the price range.
   */
  async findSimilarItems(description: string, targetValue?: number, options?: { timeoutMs?: number; retry?: Partial<RetryConfig> }): Promise<ValuerSearchResponse> {
    if (!targetValue) {
      // If no target value, just search with a default limit
      return this.search(description, undefined, undefined, 20, options);
    }

    // Calculate a price range around the target value
    const minPrice = Math.floor(targetValue * 0.7);
    const maxPrice = Math.ceil(targetValue * 1.3);

    console.log('Searching for similar items:', {
      description,
      targetValue,
      minPrice,
      maxPrice
    });

    // Search within the calculated price range, limit results
    return this.search(description, minPrice, maxPrice, 20, options); // Limit results for similarity search
  }

  /**
   * Calls the Valuer batch endpoint to run multiple searches in one request.
   */
  async batchSearch(body: {
    searches: Array<Record<string, any>>,
    cookies?: Array<Record<string, any>>,
    fetchAllPages?: boolean,
    maxPages?: number,
    concurrency?: number,
    saveToGcs?: boolean
  }, options?: { timeoutMs?: number; retry?: Partial<RetryConfig> }): Promise<any> {
    const provider = this.resolveProvider();
    if (provider === 'scraper_db') {
      return this.batchSearchScraperDb(body);
    }
    if (provider === 'auto') {
      try {
        const res = await this.batchSearchScraperDb(body);
        const minLots = (() => {
          const v = Number(process.env.SCRAPER_DB_AUTO_MIN_LOTS);
          if (Number.isFinite(v) && v >= 0) return Math.floor(v);
          return 5;
        })();
        const searches = Array.isArray(res?.searches) ? res.searches : [];
        const totalLots = searches.reduce((sum: number, s: any) => {
          const n = Array.isArray(s?.result?.data?.lots) ? s.result.data.lots.length : 0;
          return sum + n;
        }, 0);
        const minTotalLots = Math.max(minLots, minLots * Math.min(2, searches.length || 1));
        const tooSparse = totalLots < minTotalLots;
        if (!tooSparse) return res;
        console.warn(`[valuer-agent] SCRAPER_DB auto-mode: sparse results (totalLots=${totalLots}, minTotalLots=${minTotalLots}); falling back to live provider`);
      } catch (err: any) {
        console.warn(`[valuer-agent] SCRAPER_DB auto-mode failed; falling back to live provider: ${err?.message || err}`);
      }
    }
    return this.batchSearchLive(body, options);
  }

  private async batchSearchLive(body: {
    searches: Array<Record<string, any>>,
    cookies?: Array<Record<string, any>>,
    fetchAllPages?: boolean,
    maxPages?: number,
    concurrency?: number,
    saveToGcs?: boolean
  }, options?: { timeoutMs?: number; retry?: Partial<RetryConfig> }): Promise<any> {
    const url = `${this.baseUrl}/batch`;
    // Provide cookies from env if not supplied by caller
    try {
      if (!Array.isArray(body.cookies) || body.cookies.length === 0) {
        const cookies = this.getInvaluableCookies();
        if (cookies.length > 0) {
          (body as any).cookies = cookies;
        }
      }
    } catch (_) {}
    console.log(`Executing valuer batch: ${url}`);
    const authHeader = await this.getAuthHeader();
    const t0 = Date.now();
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader } as any,
      body: JSON.stringify(body)
    }, options?.retry, options?.timeoutMs);
    try { console.log(`Valuer batch HTTP completed in ${Date.now() - t0}ms`); } catch {}
    if (!response.ok) {
      const text = await response.text();
      console.error('Valuer batch error:', text);
      throw new Error(`Failed to fetch from Valuer service: ${response.statusText}`);
    }
    return response.json();
  }

  private async batchSearchScraperDb(body: { searches: Array<Record<string, any>>; concurrency?: number }): Promise<any> {
    const searches = Array.isArray(body?.searches) ? body.searches : [];
    const db = this.getScraperDb();
    const startedAt = new Date().toISOString();

    const coerceNumber = (value: any): number | undefined => {
      if (value === null || value === undefined) return undefined;
      if (typeof value === 'string' && value.trim() === '') return undefined;
      const n = typeof value === 'string' ? Number(value) : (typeof value === 'number' ? value : NaN);
      if (!Number.isFinite(n)) return undefined;
      return n;
    };

    const concurrency = (() => {
      const requested = Number((body as any)?.concurrency);
      if (Number.isFinite(requested) && requested > 0) return Math.min(10, Math.floor(requested));
      const env = Number(process.env.SCRAPER_DB_CONCURRENCY);
      if (Number.isFinite(env) && env > 0) return Math.min(10, Math.floor(env));
      return 4;
    })();

    const runLimited = async <T>(tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> => {
      const results: PromiseSettledResult<T>[] = new Array(tasks.length);
      let nextIndex = 0;

      const worker = async () => {
        while (true) {
          const idx = nextIndex;
          nextIndex += 1;
          if (idx >= tasks.length) return;
          try {
            const value = await tasks[idx]();
            results[idx] = { status: 'fulfilled', value };
          } catch (reason) {
            results[idx] = { status: 'rejected', reason };
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
      return results;
    };

    const tasks = searches.map((s: any) => async () => {
      const q = String(s?.query || '').trim();
      const minPrice = coerceNumber(s?.priceResult?.min);
      const maxPrice = coerceNumber(s?.priceResult?.max);
      const limit = coerceNumber(s?.limit);
      const lots = await db.searchLots({ query: q, minPrice, maxPrice, limit });

      const mappedLots: Array<Record<string, any>> = lots.map((lot) => {
        const thumbUrl = buildPublicAssetUrl(lot.imagePath);
        return {
          id: lot.lotUid,
          lot_uid: lot.lotUid,
          title: lot.title,
          description: lot.description,
          auctionHouse: lot.houseName,
          houseName: lot.houseName,
          house: lot.houseName,
          date: lot.auctionDate,
          dateTimeLocal: lot.auctionDate,
          auctionDate: lot.auctionDate,
          price: lot.priceRealised !== null ? {
            amount: lot.priceRealised,
            currency: lot.currency || 'USD',
            symbol: lot.currencySymbol || '$',
          } : undefined,
          priceRealised: lot.priceRealised,
          currency: lot.currency || null,
          currencyCode: lot.currency || null,
          currencySymbol: lot.currencySymbol || null,
          estimateMin: lot.estimateMin,
          estimateMax: lot.estimateMax,
          estimateLow: lot.estimateMin,
          estimateHigh: lot.estimateMax,
          lotNumber: lot.lotNumber,
          saleType: lot.saleType,
          url: lot.sourceUrl,
          lotUrl: lot.sourceUrl,
          sourceUrl: lot.sourceUrl,
          thumbUrl,
          thumbnail: thumbUrl,
          image: thumbUrl,
          thumb: thumbUrl,
          imagePath: lot.imagePath,
        };
      });

      const missingLotUids = mappedLots
        .filter((it) => !it.thumbUrl && it.lot_uid && it.imagePath)
        .map((it) => String(it.lot_uid));

      return { query: q, minPrice, maxPrice, mappedLots, missingLotUids };
    });

    const results = await runLimited(tasks, concurrency);

    const missingAll: string[] = [];
    for (const settled of results) {
      if (!settled || settled.status !== 'fulfilled') continue;
      const uids = Array.isArray(settled.value?.missingLotUids) ? settled.value.missingLotUids : [];
      for (const uid of uids) missingAll.push(uid);
    }
    const publishedThumbs = await this.publishLotThumbs(missingAll);

    const searchesOut = results.map((settled, idx) => {
      if (settled.status === 'fulfilled') {
        const q = String(settled.value?.query || '').trim();
        const minPrice = settled.value?.minPrice;
        const maxPrice = settled.value?.maxPrice;
        const mappedLots = Array.isArray(settled.value?.mappedLots) ? settled.value.mappedLots : [];

        // Patch in published thumbs (if any)
        for (const lot of mappedLots) {
          const lotUid = String(lot?.lot_uid || lot?.id || '').trim();
          if (!lotUid) continue;
          const published = publishedThumbs.get(lotUid);
          if (!published || !published.thumbUrl) continue;
          lot.thumbUrl = published.thumbUrl;
          lot.thumbnail = published.thumbUrl;
          lot.image = published.thumbUrl;
          lot.thumb = published.thumbUrl;
          if (published.srcPath) lot.imagePath = published.srcPath;
        }

        const response: ValuerResponse = {
          success: true,
          timestamp: startedAt,
          parameters: {
            query: q,
            priceResult: (minPrice !== undefined || maxPrice !== undefined) ? {
              min: minPrice !== undefined ? String(minPrice) : '',
              max: maxPrice !== undefined ? String(maxPrice) : '',
            } : undefined as any,
          },
          data: {
            lots: mappedLots as unknown as ValuerLot[],
            totalResults: mappedLots.length,
          },
        };

        return { query: q, result: response };
      }
      const fallbackQuery = String(searches[idx]?.query || '').trim();
      return {
        query: fallbackQuery,
        error: String(settled.reason?.message || settled.reason || 'scraper_db_error'),
        result: {
          success: false,
          timestamp: startedAt,
          parameters: { query: fallbackQuery },
          data: { lots: [], totalResults: 0 },
        },
      };
    });

    const completed = searchesOut.filter((s: any) => !s.error).length;
    const failed = searchesOut.length - completed;
    return {
      provider: 'scraper_db',
      batch: { total: searchesOut.length, completed, failed },
      searches: searchesOut,
    };
  }
}
