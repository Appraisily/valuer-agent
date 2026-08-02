import { randomUUID } from 'node:crypto';
import {
  validateThumbnailPublishRequest,
  validateThumbnailPublishResult,
} from '@appraisily/auction-contracts';
import type { ThumbnailPublishResultV1 } from '@appraisily/auction-contracts';
import { ValuerResponse, ValuerLot } from './types.js';
import { AuctionDataApiClient, AuctionDataApiError, buildLotImageAssetContract } from './auction-data-api.js';
import { recordBatchOutcome } from './metrics.js';

const warnedLegacyValuerSettings = new Set<string>();

export function resolveValuerEnvSetting(
  canonicalName: string,
  legacyName: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const canonicalValue = String(env[canonicalName] || '').trim();
  if (canonicalValue) return canonicalValue;
  return String(env[legacyName] || '').trim();
}

function readValuerEnvSetting(canonicalName: string, legacyName: string): string {
  const value = resolveValuerEnvSetting(canonicalName, legacyName);
  if (!String(process.env[canonicalName] || '').trim()
    && String(process.env[legacyName] || '').trim()
    && !warnedLegacyValuerSettings.has(legacyName)) {
    warnedLegacyValuerSettings.add(legacyName);
    console.warn(`[env] ${legacyName} is deprecated; use ${canonicalName}`);
  }
  return value;
}

if (process.env.SCRAPPER_THUMBS_PUBLISH_URL && !process.env.SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL) {
  console.warn('[env] SCRAPPER_THUMBS_PUBLISH_URL is deprecated; use SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL');
}

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

type AuctionDataApiReader = Pick<AuctionDataApiClient, 'searchLots' | 'close'> & Partial<Pick<AuctionDataApiClient, 'checkReadiness'>>;
type ThumbPublishResult = Map<string, { thumbUrl: string; srcPath: string; verifiedAt: string }>;

export class ValuerService {
  private auctionDataApi: AuctionDataApiReader;
  private thumbPublisher?: (lotUids: string[]) => Promise<ThumbPublishResult>;
  private transportFailures = 0;
  private circuitOpenUntil = 0;

  constructor(deps: { auctionDataApi?: AuctionDataApiReader; thumbPublisher?: (lotUids: string[]) => Promise<ThumbPublishResult> } = {}) {
    this.auctionDataApi = deps.auctionDataApi || new AuctionDataApiClient();
    this.thumbPublisher = deps.thumbPublisher;
  }

  getReadiness(): { provider: 'auction_data_api'; apiConfigured: boolean } {
    return { provider: 'auction_data_api', apiConfigured: true };
  }

  async checkReadiness(timeoutMs?: number) {
    if (!this.auctionDataApi.checkReadiness) {
      return {
        ready: false,
        status: null,
        error: 'auction_data_api_readiness_not_supported',
        latencyMs: 0,
      };
    }
    return this.auctionDataApi.checkReadiness(timeoutMs);
  }

  async close(): Promise<void> {
    await this.auctionDataApi.close();
  }

  async batchSearch(body: BatchSearchBody, options: SearchOptions = {}): Promise<any> {
    return this.batchSearchAuctionDataApi(body, options);
  }

  private async publishLotThumbs(lotUids: string[]): Promise<ThumbPublishResult> {
    if (this.thumbPublisher) return this.thumbPublisher(lotUids);

    const publishUrl = String(
      process.env.SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL ||
      process.env.SCRAPPER_THUMBS_PUBLISH_URL ||
      'http://scraper-ops-api:8080/api/lot-thumbs/publish'
    ).trim();
    const apiKey = String(process.env.OPS_THUMB_API_KEY || '').trim();
    if (!publishUrl || !apiKey) return new Map();

    const limit = (() => {
      const n = Number(readValuerEnvSetting('VALUER_PUBLISH_THUMBS_LIMIT', 'SCRAPER_DB_PUBLISH_THUMBS_LIMIT'));
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
      const requestId = `valuer-thumb-${randomUUID()}`;
      const correlationId = randomUUID();
      const request = validateThumbnailPublishRequest({
        schemaVersion: 1,
        requestId,
        correlationId,
        lotUids: unique,
        limit: unique.length,
        maxConcurrency: Math.max(1, Math.min(2, Number(process.env.SCRAPPER_THUMBS_PUBLISH_CONCURRENCY || 1) || 1)),
      });
      const res = await fetch(publishUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'x-request-id': requestId,
          'x-correlation-id': correlationId,
        } as any,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[valuer-bridge] Thumb publish failed (${res.status}): ${text.slice(0, 300)}`);
        return new Map();
      }

      const responseBody = await res.json() as ThumbnailPublishResultV1;
      const json = validateThumbnailPublishResult(responseBody);
      if (json.requestId !== requestId || json.correlationId !== correlationId) {
        throw new Error('thumb_publish_response_identity_mismatch');
      }
      const out: ThumbPublishResult = new Map();
      const published = json.published;
      for (const item of published) {
        const lotUid = String(item?.lotUid || '').trim();
        if (!lotUid) continue;
        out.set(lotUid, {
          thumbUrl: String(item.thumbUrl),
          srcPath: String(item.srcPath),
          verifiedAt: new Date(item.verifiedAt).toISOString(),
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

  private circuitThreshold(): number {
    return Math.max(1, Number(process.env.AUCTION_DATA_API_CIRCUIT_FAILURES || 5));
  }

  private circuitCooldownMs(): number {
    return Math.max(1_000, Number(process.env.AUCTION_DATA_API_CIRCUIT_COOLDOWN_MS || 15_000));
  }

  private ensureCircuitAvailable(): void {
    if (this.circuitOpenUntil > Date.now()) {
      throw new AuctionDataApiError('auction_data_api_circuit_open', { transient: true });
    }
    if (this.circuitOpenUntil) {
      this.circuitOpenUntil = 0;
      this.transportFailures = 0;
    }
  }

  private recordTransportSuccess(): void {
    this.transportFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordTransportFailure(error: unknown): void {
    if (!(error instanceof AuctionDataApiError) || !error.transient) return;
    this.transportFailures += 1;
    if (this.transportFailures >= this.circuitThreshold()) {
      this.circuitOpenUntil = Date.now() + this.circuitCooldownMs();
    }
  }

  private async searchWithBudget(
    params: { query: string; minPrice?: number; maxPrice?: number; limit?: number },
    options: SearchOptions,
    deadlineAt: number,
  ): Promise<{ lots: Awaited<ReturnType<AuctionDataApiReader['searchLots']>>; attempts: number }> {
    const maxAttempts = Math.max(1, Math.min(4, Math.floor(options.retry?.attempts || 1)));
    const baseDelayMs = Math.max(10, Math.floor(options.retry?.baseDelayMs || 100));
    const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.retry?.maxDelayMs || 750));
    let attempts = 0;
    let lastError: unknown;

    while (attempts < maxAttempts) {
      if (Date.now() >= deadlineAt) throw new AuctionDataApiError('deadline_exhausted', { transient: true });
      this.ensureCircuitAvailable();
      attempts += 1;
      try {
        const lots = await this.auctionDataApi.searchLots(params, { deadlineAt });
        this.recordTransportSuccess();
        return { lots, attempts };
      } catch (error) {
        lastError = error;
        this.recordTransportFailure(error);
        const retryable = error instanceof AuctionDataApiError && error.transient;
        if (!retryable || attempts >= maxAttempts) break;
        const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempts - 1)));
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= delayMs) throw new AuctionDataApiError('deadline_exhausted', { transient: true });
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw lastError || new AuctionDataApiError('auction_data_api_transport_error', { transient: true });
  }

  private async batchSearchAuctionDataApi(body: BatchSearchBody, options: SearchOptions): Promise<any> {
    const searches = Array.isArray(body?.searches) ? body.searches : [];
    const startedAt = new Date().toISOString();
    const requestedTimeout = Number(options.timeoutMs || process.env.VALUER_BATCH_HTTP_TIMEOUT_MS || 30_000);
    const timeoutMs = Math.max(100, Math.min(120_000, Number.isFinite(requestedTimeout) ? requestedTimeout : 30_000));
    const deadlineAt = Date.now() + timeoutMs;
    const skipThumbPublish = (() => {
      if (body.skipThumbPublish) return true;
      const raw = readValuerEnvSetting('VALUER_PUBLISH_THUMBS_DISABLED', 'SCRAPER_DB_PUBLISH_THUMBS_DISABLED').toLowerCase();
      return raw === '1' || raw === 'true' || raw === 'yes';
    })();

    const concurrency = (() => {
      const requested = Number(body.concurrency);
      if (Number.isFinite(requested) && requested > 0) return Math.min(10, Math.floor(requested));
      const env = Number(readValuerEnvSetting('VALUER_CONCURRENCY', 'SCRAPER_DB_CONCURRENCY'));
      if (Number.isFinite(env) && env > 0) return Math.min(10, Math.floor(env));
      return 4;
    })();

    const tasks = searches.map((search: any) => async () => {
      const query = String(search?.query || '').trim();
      const minPrice = coerceNumber(search?.priceResult?.min);
      const maxPrice = coerceNumber(search?.priceResult?.max);
      const limit = coerceNumber(search?.limit);
      const { lots, attempts } = await this.searchWithBudget({ query, minPrice, maxPrice, limit }, options, deadlineAt);

      const mappedLots = lots.map((lot) => {
        const imageAssets = buildLotImageAssetContract(lot.imageUrl);
        const ownedAvailable = lot.assetStatus === 'available'
          && Boolean(imageAssets.imageUrl)
          && imageAssets.imagePath?.split('/')[1] === String(lot.lotUid)
          && Boolean(lot.assetVerifiedAt);
        return {
          schemaVersion: 1 as const,
          lotUid: lot.lotUid,
          lotRef: lot.lotRef,
          title: lot.title,
          description: lot.description,
          houseName: lot.houseName,
          saleType: lot.saleType,
          auctionDate: lot.auctionDate,
          priceRealised: lot.priceRealised,
          currency: lot.currency,
          estimateMin: lot.estimateMin,
          estimateMax: lot.estimateMax,
          lotNumber: lot.lotNumber,
          sourceUrl: lot.sourceUrl,
          rankingScore: lot.rankingScore,
          imageUrl: ownedAvailable ? imageAssets.imageUrl : null,
          assetStatus: ownedAvailable ? 'available' : (lot.assetStatus === 'unavailable' ? 'unavailable' : 'unknown'),
          assetVerifiedAt: ownedAvailable ? lot.assetVerifiedAt : null,
        };
      });

      const missingLotUids = lots
        // The Auction Data API may know the exact lot while its legacy asset
        // status/image hint is stale. The bounded publisher is the canonical
        // existence check, so let it resolve missing owned assets by lot UID
        // instead of requiring an already-populated image field.
        .filter((lot, index) => !mappedLots[index]?.imageUrl && lot.lotUid)
        .map((lot) => String(lot.lotUid));

      return { query, minPrice, maxPrice, mappedLots, missingLotUids, attempts };
    });

    const results = await runLimited(tasks, concurrency);
    const publishedThumbs: ThumbPublishResult = new Map();

    if (!skipThumbPublish && deadlineAt - Date.now() > 1_000) {
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
        const reason = (settled as PromiseRejectedResult).reason;
        const errorCode = reason instanceof AuctionDataApiError
          ? reason.code
          : String(reason?.message || reason || 'auction_data_api_error');
        return {
          query: failedQuery,
          error: errorCode,
          diagnostic: {
            kind: reason instanceof AuctionDataApiError && reason.transient ? 'upstream_transient' : 'upstream_permanent',
            upstreamStatus: reason instanceof AuctionDataApiError ? reason.status : null,
            retryable: reason instanceof AuctionDataApiError ? reason.transient : false,
          },
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
        const lotUid = String(lot?.lotUid || '').trim();
        if (!lotUid) continue;
        const published = publishedThumbs.get(lotUid);
        if (!published) continue;
        const imageAssets = buildLotImageAssetContract(published.srcPath);
        if (!imageAssets.thumbUrl && !imageAssets.imageUrl) continue;
        lot.imageUrl = imageAssets.imageUrl || imageAssets.thumbUrl;
        lot.assetStatus = lot.imageUrl ? 'available' : lot.assetStatus;
        if (lot.imageUrl) lot.assetVerifiedAt = published.verifiedAt;
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

      return { query, attempts: settled.value.attempts, result: response };
    });

    const completed = searchesOut.filter((search: any) => !search.error).length;
    const failed = searchesOut.length - completed;
    recordBatchOutcome(completed, failed);
    return {
      provider: 'auction_data_api',
      batch: { total: searchesOut.length, completed, failed },
      diagnostics: {
        deadlineMs: timeoutMs,
        partial: completed > 0 && failed > 0,
        deadlineExhausted: Date.now() >= deadlineAt,
        failures: searchesOut.filter((search: any) => search.error).map((search: any) => ({
          query: search.query,
          error: search.error,
          ...search.diagnostic,
        })),
      },
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
