import { ValuerResponse, ValuerLot } from './types.js';
import { ScraperDbClient, buildLotImageAssetContract } from './scraper-db.js';

type SearchOptions = {
  timeoutMs?: number;
  retry?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
};

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
  private scraperDb: ScraperDbClient;

  private async publishLotThumbs(lotUids: string[]): Promise<Map<string, { thumbUrl: string | null; srcPath: string | null }>> {
    const publishUrl = String(process.env.SCRAPPER_THUMBS_PUBLISH_URL || 'http://scrapper:8080/api/lot-thumbs/publish').trim();
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
        body: JSON.stringify({
          lotUids: unique,
          limit: unique.length,
          maxConcurrency: Math.max(1, Math.min(2, Number(process.env.SCRAPPER_THUMBS_PUBLISH_CONCURRENCY || 1) || 1)),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[valuer-bridge] Thumb publish failed (${res.status}): ${text.slice(0, 300)}`);
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
      console.warn(`[valuer-bridge] Thumb publish request error: ${err?.message || err}`);
      return new Map();
    } finally {
      clearTimeout(id);
    }
  }

  constructor() {
    this.scraperDb = new ScraperDbClient();
  }

  getReadiness(): { provider: 'scraper_db'; dbConfigured: boolean } {
    return { provider: 'scraper_db', dbConfigured: true };
  }

  async close(): Promise<void> {
    await this.scraperDb.close();
  }

  /**
   * Executes multiple searches in a single request via Valuer batch endpoint.
   * Returns hits per query in the same ValuerHit shape used by single search.
   */
  async multiSearch(
    inputs: Array<{ query: string; minPrice?: number; maxPrice?: number; limit?: number }>,
    _options?: SearchOptions
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

  /**
   * Core search function backed by the local scraper DB.
   * @param query Search query string
   * @param minPrice Optional minimum price filter
   * @param maxPrice Optional maximum price filter
   * @param limit Optional limit for the number of DB results
   * @returns Promise with the raw search results (hits)
   */
  async search(query: string, minPrice?: number, maxPrice?: number, limit?: number, _options?: SearchOptions): Promise<ValuerSearchResponse> {
    const lots = await this.scraperDb.searchLots({ query, minPrice, maxPrice, limit });
    const hits = lots
      .map((lot) => transformValuerLotToHit({
        title: lot.title || '',
        description: lot.description || '',
        auctionHouse: lot.houseName || '',
        date: lot.auctionDate || '',
        price: {
          amount: lot.priceRealised || 0,
          currency: lot.currency || 'USD',
          symbol: lot.currencySymbol || '$',
        },
        lotNumber: lot.lotNumber || '',
        saleType: lot.saleType || '',
      } as ValuerLot))
      .filter((hit) => Boolean(hit.lotTitle && hit.priceResult));

    console.log(`Valuer Bridge DB response for query "${query}" (found ${hits.length} hits):
      First 10 titles: ${hits.slice(0, 10).map(h => h.lotTitle).join(', ')}`);

    if (hits.length === 0) {
      console.log('No results found for query:', query);
    }

    return { hits };
  }

  /**
   * Finds valuable auction results for a given keyword.
   * @param keyword User search keyword
   * @param minPrice Minimum price to filter results (default: 1000)
   * @param limit Maximum number of results to return after sorting (default: 10)
   * @returns Promise with auction results matching the criteria, sorted and limited.
   */
  async findValuableResults(keyword: string, minPrice: number = 1000, limit: number = 10, options?: SearchOptions): Promise<ValuerSearchResponse> {
    const initialLimit = limit * 2;
    const results = await this.search(keyword, minPrice, undefined, initialLimit, options);
    const allHits = [...results.hits];

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
  async findSimilarItems(description: string, targetValue?: number, options?: SearchOptions): Promise<ValuerSearchResponse> {
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
   * Runs multiple DB-backed searches in one request-shaped call.
   */
  async batchSearch(body: {
    searches: Array<Record<string, any>>,
    fetchAllPages?: boolean,
    maxPages?: number,
    concurrency?: number,
    saveToGcs?: boolean,
    skipThumbPublish?: boolean,
  }, _options?: SearchOptions): Promise<any> {
    return this.batchSearchScraperDb(body);
  }

  private async batchSearchScraperDb(body: { searches: Array<Record<string, any>>; concurrency?: number; skipThumbPublish?: boolean }): Promise<any> {
    const searches = Array.isArray(body?.searches) ? body.searches : [];
    const startedAt = new Date().toISOString();

    const skipThumbPublish = (() => {
      if ((body as any)?.skipThumbPublish) return true;
      const raw = String(process.env.SCRAPER_DB_PUBLISH_THUMBS_DISABLED || '').toLowerCase().trim();
      return raw === '1' || raw === 'true' || raw === 'yes';
    })();

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
      const lots = await this.scraperDb.searchLots({ query: q, minPrice, maxPrice, limit });

      const mappedLots: Array<Record<string, any>> = lots.map((lot) => {
        const imageAssets = buildLotImageAssetContract(lot.imagePath);
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
          thumbUrl: imageAssets.thumbUrl,
          thumbnail: imageAssets.thumbUrl,
          imageUrl: imageAssets.imageUrl,
          image: imageAssets.imageUrl || imageAssets.thumbUrl,
          thumb: imageAssets.thumbUrl,
          originalUrl: imageAssets.originalUrl,
          imageOriginalUrl: imageAssets.imageOriginalUrl,
          imagePath: imageAssets.imagePath,
          thumbPath: imageAssets.thumbPath,
          mediumPath: imageAssets.mediumPath,
          originalPath: imageAssets.originalPath,
          imageFileName: lot.imageFileName,
        };
      });

      const missingLotUids = mappedLots
        .filter((it) => !it.thumbUrl && it.lot_uid && (it.imagePath || it.imageFileName))
        .map((it) => String(it.lot_uid));

      return { query: q, minPrice, maxPrice, mappedLots, missingLotUids };
    });

    const results = await runLimited(tasks, concurrency);

    // Always use a Map so downstream `.get()`/`.set()` calls cannot crash.
    // When publishing is disabled, this stays empty and is simply a no-op.
    const publishedThumbs = new Map<string, { thumbUrl: string | null; srcPath: string | null }>();

    if (!skipThumbPublish) {
      const missingAll: string[] = [];
      for (const settled of results) {
        if (!settled || settled.status !== 'fulfilled') continue;
        const uids = Array.isArray(settled.value?.missingLotUids) ? settled.value.missingLotUids : [];
        for (const uid of uids) missingAll.push(uid);
      }
      const published = await this.publishLotThumbs(missingAll);
      for (const [key, value] of published.entries()) publishedThumbs.set(key, value);
    }

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
          const imageAssets = buildLotImageAssetContract(published.srcPath);
          lot.thumbUrl = imageAssets.thumbUrl || published.thumbUrl;
          lot.thumbnail = lot.thumbUrl;
          lot.imageUrl = imageAssets.imageUrl || lot.thumbUrl;
          lot.image = lot.imageUrl || lot.thumbUrl;
          lot.thumb = lot.thumbUrl;
          lot.originalUrl = imageAssets.originalUrl || lot.imageUrl || lot.thumbUrl;
          lot.imageOriginalUrl = imageAssets.imageOriginalUrl || lot.originalUrl;
          if (imageAssets.imagePath) lot.imagePath = imageAssets.imagePath;
          if (imageAssets.thumbPath) lot.thumbPath = imageAssets.thumbPath;
          if (imageAssets.mediumPath) lot.mediumPath = imageAssets.mediumPath;
          if (imageAssets.originalPath) lot.originalPath = imageAssets.originalPath;
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
      const failedQuery = String(searches[idx]?.query || '').trim();
      return {
        query: failedQuery,
        error: String(settled.reason?.message || settled.reason || 'scraper_db_error'),
        result: {
          success: false,
          timestamp: startedAt,
          parameters: { query: failedQuery },
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
