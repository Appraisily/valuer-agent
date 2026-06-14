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

type BatchSearchBody = {
  searches: Array<Record<string, any>>;
  fetchAllPages?: boolean;
  maxPages?: number;
  concurrency?: number;
  saveToGcs?: boolean;
  skipThumbPublish?: boolean;
};

type ScraperDbReader = Pick<ScraperDbClient, 'searchLots' | 'close'>;
type ThumbPublishResult = Map<string, { thumbUrl: string | null; srcPath: string | null }>;

export class ValuerService {
  private scraperDb: ScraperDbReader;
  private thumbPublisher?: (lotUids: string[]) => Promise<ThumbPublishResult>;

  constructor(deps: { scraperDb?: ScraperDbReader; thumbPublisher?: (lotUids: string[]) => Promise<ThumbPublishResult> } = {}) {
    this.scraperDb = deps.scraperDb || new ScraperDbClient();
    this.thumbPublisher = deps.thumbPublisher;
  }

  getReadiness(): { provider: 'scraper_db'; dbConfigured: boolean } {
    return { provider: 'scraper_db', dbConfigured: true };
  }

  async close(): Promise<void> {
    await this.scraperDb.close();
  }

  async batchSearch(body: BatchSearchBody, _options?: SearchOptions): Promise<any> {
    return this.batchSearchScraperDb(body);
  }

  private async publishLotThumbs(lotUids: string[]): Promise<ThumbPublishResult> {
    if (this.thumbPublisher) return this.thumbPublisher(lotUids);

    const publishUrl = String(process.env.SCRAPPER_THUMBS_PUBLISH_URL || 'http://scrapper:8080/api/lot-thumbs/publish').trim();
    const apiKey = String(process.env.SCRAPPER_INTERNAL_API_KEY || '').trim();
    if (!publishUrl || !apiKey) return new Map();

    const limit = (() => {
      const n = Number(process.env.SCRAPER_DB_PUBLISH_THUMBS_LIMIT);
      if (!Number.isFinite(n) || n <= 0) return 12;
      return Math.max(1, Math.min(100, Math.floor(n)));
    })();

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const uid of lotUids) {
      const value = String(uid || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      unique.push(value);
      if (unique.length >= limit) break;
    }
    if (!unique.length) return new Map();

    const controller = new AbortController();
    const timeoutMs = (() => {
      const env = Number(process.env.SCRAPPER_THUMBS_PUBLISH_TIMEOUT_MS);
      return Number.isFinite(env) && env > 0 ? Math.floor(env) : 60_000;
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
      const out = new Map<string, { thumbUrl: string | null; srcPath: string | null }>();
      const published = Array.isArray(json?.published) ? json.published : [];
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

  private async batchSearchScraperDb(body: BatchSearchBody): Promise<any> {
    const searches = Array.isArray(body?.searches) ? body.searches : [];
    const startedAt = new Date().toISOString();
    const skipThumbPublish = (() => {
      if (body.skipThumbPublish) return true;
      const raw = String(process.env.SCRAPER_DB_PUBLISH_THUMBS_DISABLED || '').toLowerCase().trim();
      return raw === '1' || raw === 'true' || raw === 'yes';
    })();

    const concurrency = (() => {
      const requested = Number(body.concurrency);
      if (Number.isFinite(requested) && requested > 0) return Math.min(10, Math.floor(requested));
      const env = Number(process.env.SCRAPER_DB_CONCURRENCY);
      if (Number.isFinite(env) && env > 0) return Math.min(10, Math.floor(env));
      return 4;
    })();

    const tasks = searches.map((search: any) => async () => {
      const query = String(search?.query || '').trim();
      const minPrice = coerceNumber(search?.priceResult?.min);
      const maxPrice = coerceNumber(search?.priceResult?.max);
      const limit = coerceNumber(search?.limit);
      const lots = await this.scraperDb.searchLots({ query, minPrice, maxPrice, limit });

      const mappedLots = lots.map((lot) => {
        const imageAssets = buildLotImageAssetContract(lot.imagePath);
        return {
          id: lot.lotUid,
          lot_uid: lot.lotUid,
          lotRef: lot.lotRef,
          lot_ref: lot.lotRef,
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
          lot_url: lot.sourceUrl,
          sourceUrl: lot.sourceUrl,
          source_url: lot.sourceUrl,
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

      const missingLotUids = lots
        .filter((lot, index) => !mappedLots[index]?.thumbUrl && lot.lotUid && (lot.imagePath || lot.imageFileName))
        .map((lot) => String(lot.lotUid));

      return { query, minPrice, maxPrice, mappedLots, missingLotUids };
    });

    const results = await runLimited(tasks, concurrency);
    const publishedThumbs = new Map<string, { thumbUrl: string | null; srcPath: string | null }>();

    if (!skipThumbPublish) {
      const missingAll: string[] = [];
      for (const settled of results) {
        if (settled?.status !== 'fulfilled') continue;
        const uids = Array.isArray(settled.value?.missingLotUids) ? settled.value.missingLotUids : [];
        for (const uid of uids) missingAll.push(uid);
      }
      const published = await this.publishLotThumbs(missingAll);
      for (const [key, value] of published.entries()) publishedThumbs.set(key, value);
    }

    const searchesOut = results.map((settled, index) => {
      if (settled.status !== 'fulfilled') {
        const failedQuery = String(searches[index]?.query || '').trim();
        return {
          query: failedQuery,
          error: String((settled as PromiseRejectedResult).reason?.message || (settled as PromiseRejectedResult).reason || 'scraper_db_error'),
          result: {
            success: false,
            timestamp: startedAt,
            parameters: { query: failedQuery },
            data: { lots: [], totalResults: 0 },
          },
        };
      }

      const query = String(settled.value?.query || '').trim();
      const mappedLots = Array.isArray(settled.value?.mappedLots) ? settled.value.mappedLots : [];
      for (const lot of mappedLots) {
        const lotUid = String(lot?.lot_uid || lot?.id || '').trim();
        if (!lotUid) continue;
        const published = publishedThumbs.get(lotUid);
        if (!published?.thumbUrl && !published?.srcPath) continue;
        const imageAssets = buildLotImageAssetContract(published.srcPath || published.thumbUrl);
        if (!imageAssets.thumbUrl && !imageAssets.imageUrl) continue;
        lot.thumbUrl = imageAssets.thumbUrl || imageAssets.imageUrl;
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
          query,
          priceResult: settled.value.minPrice !== undefined || settled.value.maxPrice !== undefined ? {
            min: settled.value.minPrice !== undefined ? String(settled.value.minPrice) : '',
            max: settled.value.maxPrice !== undefined ? String(settled.value.maxPrice) : '',
          } : undefined,
        },
        data: {
          lots: mappedLots as unknown as ValuerLot[],
          totalResults: mappedLots.length,
        },
      };

      return { query, result: response };
    });

    const completed = searchesOut.filter((search: any) => !search.error).length;
    const failed = searchesOut.length - completed;
    return {
      provider: 'scraper_db',
      batch: { total: searchesOut.length, completed, failed },
      searches: searchesOut,
    };
  }
}

function coerceNumber(value: any): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : (typeof value === 'number' ? value : NaN);
  return Number.isFinite(n) ? n : undefined;
}

async function runLimited<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}
