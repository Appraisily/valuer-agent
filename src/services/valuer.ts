import { ValuerResponse, ValuerLot } from './types.js';

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

async function fetchWithRetry(input: string, init: RequestInit, retry?: Partial<RetryConfig>): Promise<Response> {
  const cfg: RetryConfig = {
    attempts: Math.max(1, Number(process.env.VALUER_RETRY_ATTEMPTS || retry?.attempts || 4)),
    baseDelayMs: Math.max(100, Number(process.env.VALUER_RETRY_BASE_MS || retry?.baseDelayMs || 500)),
    maxDelayMs: Math.max(500, Number(process.env.VALUER_RETRY_MAX_MS || retry?.maxDelayMs || 4000)),
  };

  let lastError: any;
  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    try {
      const res = await fetch(input, init);
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
  private baseUrl = (process.env.VALUER_BASE_URL || 'https://valuer-dev-856401495068.us-central1.run.app/api/search').replace(/\/?$/, '');

  private audienceOrigin: string;
  private cachedAuthHeader: { Authorization: string } | null = null;

  constructor() {
    // Audience must be the service origin (no path) for Cloud Run ID tokens
    const parsed = new URL(this.baseUrl);
    // If baseUrl already includes a path like /api/search, only use the origin for audience
    this.audienceOrigin = `${parsed.protocol}//${parsed.host}`;
  }

  /**
   * Executes multiple searches in a single request via Valuer batch endpoint.
   * Returns hits per query in the same ValuerHit shape used by single search.
   */
  async multiSearch(
    inputs: Array<{ query: string; minPrice?: number; maxPrice?: number; limit?: number }>
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

    const res = await this.batchSearch(body);
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
    if (process.env.VALUER_AUTH_DISABLED === 'true') {
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
  async search(query: string, minPrice?: number, maxPrice?: number, limit?: number): Promise<ValuerSearchResponse> {
    const params = new URLSearchParams({
      query,
      ...(minPrice !== undefined && { 'priceResult[min]': minPrice.toString() }),
      ...(maxPrice !== undefined && { 'priceResult[max]': maxPrice.toString() }),
      ...(limit !== undefined && { 'limit': limit.toString() })
    });

    // Add sorting by relevance
    params.append('sort', 'relevance');

    const url = `${this.baseUrl}?${params}`;
    console.log(`Executing valuer search: ${url}`);
    const authHeader = await this.getAuthHeader();
    const response = await fetchWithRetry(url, { headers: { ...authHeader } as any });

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
  async findValuableResults(keyword: string, minPrice: number = 1000, limit: number = 10): Promise<ValuerSearchResponse> {
    // Initial search with the original keyword and a potentially larger internal limit
    // Fetch more initially (e.g., limit * 2) to allow for better merging/filtering later
    const initialLimit = limit * 2;
    let results = await this.search(keyword, minPrice, undefined, initialLimit);
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
          const additionalResults = await this.search(significantKeywords, minPrice, undefined, remainingLimit > 0 ? remainingLimit : undefined);

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
  async findSimilarItems(description: string, targetValue?: number): Promise<ValuerSearchResponse> {
    if (!targetValue) {
      // If no target value, just search with a default limit
      return this.search(description, undefined, undefined, 20);
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
    return this.search(description, minPrice, maxPrice, 20); // Limit results for similarity search
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
  }): Promise<any> {
    const url = `${this.baseUrl}/batch`;
    console.log(`Executing valuer batch: ${url}`);
    const authHeader = await this.getAuthHeader();
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader } as any,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      console.error('Valuer batch error:', text);
      throw new Error(`Failed to fetch from Valuer service: ${response.statusText}`);
    }
    return response.json();
  }
}