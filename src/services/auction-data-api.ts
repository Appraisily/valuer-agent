import {
  buildPublicAuctionImageUrl,
  normalizeAssetsOrigin,
  normalizePublicAuctionImagePath,
  normalizePublicAuctionImageUrl,
  validateComparableLot,
  type CanonicalComparableLotV1,
} from '@appraisily/auction-contracts';
import { recordUpstreamSearch } from './metrics.js';

type CurrencyCode = string | null | undefined;
type NullableString = string | null | undefined;

export type AuctionDataApiSearchParams = {
  query: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
};

export type AuctionDataApiSearchOptions = {
  deadlineAt?: number;
  timeoutMs?: number;
};

export type AuctionDataApiReadiness = {
  ready: boolean;
  status: number | null;
  error: string | null;
  latencyMs: number;
};

type AuctionDataApiClientOptions = {
  dataApiUrl?: string;
  dataApiKey?: string;
  assetsBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function resolveAuctionDataApiConfig(
  env: Record<string, string | undefined> = process.env,
): { url: string; key: string; configured: boolean } {
  const url = normalizeBaseUrl(env.AUCTION_DATA_API_URL, 'http://scraper-orchestrator:8080');
  const key = String(env.AUCTION_DATA_API_KEY || env.INGEST_API_KEY || '').trim();
  return { url, key, configured: Boolean(url && key) };
}

export class AuctionDataApiError extends Error {
  code: string;
  status: number | null;
  transient: boolean;

  constructor(code: string, { status = null, transient = false }: { status?: number | null; transient?: boolean } = {}) {
    super(code);
    this.name = 'AuctionDataApiError';
    this.code = code;
    this.status = status;
    this.transient = transient;
  }
}

export type AuctionDataApiLot = {
  lotUid: string;
  lotRef: string | null;
  title: string | null;
  description: string | null;
  houseName: string | null;
  auctionDate: string | null;
  priceRealised: number | null;
  currency: string | null;
  currencySymbol: string | null;
  estimateMin: number | null;
  estimateMax: number | null;
  lotNumber: string | null;
  saleType: string | null;
  sourceUrl: string | null;
  rankingScore: number | null;
  imagePath: string | null;
  imageFileName: string | null;
  imageUrl: string | null;
  assetStatus: 'available' | 'unavailable' | 'unknown';
  assetVerifiedAt: string | null;
};

export function toCanonicalComparableLot(lot: AuctionDataApiLot): CanonicalComparableLotV1 {
  const comparable: CanonicalComparableLotV1 = {
    schemaVersion: 1,
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
    assetStatus: lot.assetStatus,
    assetVerifiedAt: lot.assetVerifiedAt,
    imageUrl: lot.assetStatus === 'available' ? lot.imageUrl : null,
  };
  return validateComparableLot(comparable);
}

function normalizeBaseUrl(value: string | undefined | null, fallback: string): string {
  const raw = (value || '').trim();
  if (!raw) return fallback;
  return raw.replace(/\/+$/, '');
}

export function isPublishedAssetPath(relativePath: NullableString): boolean {
  return normalizePublicAuctionImagePath(relativePath) !== null;
}

function currencyToSymbol(code: CurrencyCode): string {
  const upper = String(code || 'USD').toUpperCase();
  const map: Record<string, string> = {
    USD: '$',
    GBP: '£',
    EUR: '€',
    CAD: '$',
    AUD: '$',
    NZD: '$',
    CHF: 'CHF',
    JPY: '¥',
    CNY: '¥',
    HKD: '$',
    SGD: '$',
  };
  return map[upper] || upper;
}

function pickFirstNonEmpty(...values: NullableString[]): string | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function slugifyForInvaluableUrl(value: NullableString): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

export function deriveInvaluableLotUrl(opts: {
  sourceUrl?: NullableString;
  title?: NullableString;
  lotRef?: NullableString;
  lotNumber?: NullableString;
}): string | null {
  const directUrl = pickFirstNonEmpty(opts.sourceUrl);
  if (directUrl && /^https?:\/\//i.test(directUrl)) return directUrl;

  const titleSlug = slugifyForInvaluableUrl(opts.title);
  const lotRefSlug = slugifyForInvaluableUrl(opts.lotRef);
  if (!titleSlug || !lotRefSlug) return null;

  const parts = ['https://www.invaluable.com/auction-lot', titleSlug];
  const lotNumberSlug = slugifyForInvaluableUrl(opts.lotNumber);
  if (lotNumberSlug) parts.push(lotNumberSlug);
  parts.push('c', lotRefSlug);
  return parts.join('-');
}

export function buildPublicAssetUrl(relativePath: string | null, assetsBaseUrl?: NullableString): string | null {
  const base = normalizeAssetsOrigin(
    assetsBaseUrl
    || process.env.PUBLIC_ASSETS_BASE_URL
    || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC
    || process.env.LOCAL_STORAGE_BASE_URL,
  );
  const clean = normalizePublicAssetPath(relativePath, base);
  if (!clean) return null;
  return buildPublicAuctionImageUrl(clean, base);
}

export type LotImageAssetContract = {
  imagePath: string | null;
  thumbPath: string | null;
  mediumPath: string | null;
  originalPath: string | null;
  thumbUrl: string | null;
  imageUrl: string | null;
  originalUrl: string | null;
  imageOriginalUrl: string | null;
};

function normalizePublicAssetPath(relativePath: NullableString, assetsBaseUrl?: NullableString): string | null {
  const raw = String(relativePath || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    const origin = normalizeAssetsOrigin(
      assetsBaseUrl
      || process.env.PUBLIC_ASSETS_BASE_URL
      || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC
      || process.env.LOCAL_STORAGE_BASE_URL,
    );
    const canonicalUrl = origin ? normalizePublicAuctionImageUrl(raw, origin) : null;
    if (!canonicalUrl) return null;
    return normalizePublicAuctionImagePath(decodeURIComponent(new URL(canonicalUrl).pathname.replace(/^\/+/, '')));
  }
  return normalizePublicAuctionImagePath(raw);
}

export function buildLotImageAssetContract(relativePath: NullableString, assetsBaseUrl?: NullableString): LotImageAssetContract {
  const clean = normalizePublicAssetPath(relativePath, assetsBaseUrl);
  if (!clean || !isPublishedAssetPath(clean)) {
    return {
      imagePath: null,
      thumbPath: null,
      mediumPath: null,
      originalPath: null,
      thumbUrl: null,
      imageUrl: null,
      originalUrl: null,
      imageOriginalUrl: null,
    };
  }

  const imagePath = clean;
  const imageUrl = buildPublicAssetUrl(clean, assetsBaseUrl);

  return {
    imagePath,
    thumbPath: clean,
    mediumPath: clean,
    originalPath: clean,
    thumbUrl: imageUrl,
    imageUrl,
    originalUrl: imageUrl,
    imageOriginalUrl: imageUrl,
  };
}

export class AuctionDataApiClient {
  private dataApiUrl: string;
  private dataApiKey: string;
  private assetsBaseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(options: AuctionDataApiClientOptions = {}) {
    const config = resolveAuctionDataApiConfig({
      ...process.env,
      ...(options.dataApiUrl === undefined ? {} : { AUCTION_DATA_API_URL: options.dataApiUrl }),
      ...(options.dataApiKey === undefined ? {} : { AUCTION_DATA_API_KEY: options.dataApiKey, INGEST_API_KEY: '' }),
    });
    this.dataApiUrl = config.url;
    this.dataApiKey = config.key;
    if (!this.dataApiKey) throw new Error('Missing AUCTION_DATA_API_KEY');

    this.assetsBaseUrl = normalizeBaseUrl(
      options.assetsBaseUrl || process.env.PUBLIC_ASSETS_BASE_URL || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC || process.env.LOCAL_STORAGE_BASE_URL,
      'https://assets.appraisily.com',
    );
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async close(): Promise<void> {}

  async checkReadiness(timeoutMs = 2_000): Promise<AuctionDataApiReadiness> {
    const startedAt = Date.now();
    const boundedTimeoutMs = Math.max(100, Math.min(5_000, Number(timeoutMs) || 2_000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('auction_data_api_readiness_timeout')), boundedTimeoutMs);

    try {
      const response = await this.fetchImpl(`${this.dataApiUrl}/api/v1/health`, {
        headers: {
          accept: 'application/json',
          'x-api-key': this.dataApiKey,
        },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as { success?: boolean } | null;
      const ready = response.ok && payload?.success === true;
      return {
        ready,
        status: response.status,
        error: ready ? null : `auction_data_api_${response.status}`,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      const timedOut = controller.signal.aborted || error?.name === 'AbortError';
      return {
        ready: false,
        status: null,
        error: timedOut ? 'auction_data_api_readiness_timeout' : 'auction_data_api_unreachable',
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async searchLots(params: AuctionDataApiSearchParams, options: AuctionDataApiSearchOptions = {}): Promise<AuctionDataApiLot[]> {
    const startedAt = Date.now();
    const query = String(params.query || '').trim();
    if (!query) return [];
    const limit = Math.max(1, Math.min(200, Number(params.limit || 50)));
    const minPrice = Number.isFinite(params.minPrice as number) ? Number(params.minPrice) : null;
    const maxPrice = Number.isFinite(params.maxPrice as number) ? Number(params.maxPrice) : null;

    const remainingMs = options.deadlineAt == null ? Infinity : options.deadlineAt - Date.now();
    if (remainingMs <= 0) throw new AuctionDataApiError('deadline_exhausted', { transient: true });
    const controller = new AbortController();
    const configuredTimeout = Math.max(100, Number(options.timeoutMs || process.env.AUCTION_DATA_API_TIMEOUT_MS || 10_000));
    const timeoutMs = Math.max(1, Math.min(configuredTimeout, remainingMs));
    const timeout = setTimeout(() => controller.abort(new Error('auction_data_api_timeout')), timeoutMs);
    let rows: any[];
    try {
      const response = await this.fetchImpl(`${this.dataApiUrl}/api/v1/comparables/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.dataApiKey,
        },
        body: JSON.stringify({ query, minPrice, maxPrice, limit }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; lots?: any[]; error?: string } | null;
      if (!response.ok || !payload || payload.success !== true || !Array.isArray(payload.lots)) {
        const code = payload?.error || `auction_data_api_${response.status}`;
        throw new AuctionDataApiError(code, {
          status: response.status,
          transient: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      rows = payload.lots;
      recordUpstreamSearch('success', Date.now() - startedAt, rows.length);
    } catch (error: any) {
      const status = error instanceof AuctionDataApiError
        ? (error.code.includes('timeout') || error.code === 'deadline_exhausted' ? 'timeout' : (error.transient ? 'transient_error' : 'permanent_error'))
        : (controller.signal.aborted || error?.name === 'AbortError' ? 'timeout' : 'transport_error');
      recordUpstreamSearch(status, Date.now() - startedAt);
      if (error instanceof AuctionDataApiError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new AuctionDataApiError('auction_data_api_timeout', { transient: true });
      }
      throw new AuctionDataApiError('auction_data_api_transport_error', { transient: true });
    } finally {
      clearTimeout(timeout);
    }
    return rows.map((row: any) => {
      const auctionDate = row.auctionDate ? new Date(row.auctionDate).toISOString() : null;
      const currency = row.currency || null;
      const currencySymbol = row.currencySymbol || currencyToSymbol(currency);
      const price = row.priceRealised !== null && row.priceRealised !== undefined
        ? Number(row.priceRealised)
        : null;
      const estimateMin = row.estimateMin !== null && row.estimateMin !== undefined ? Number(row.estimateMin) : null;
      const estimateMax = row.estimateMax !== null && row.estimateMax !== undefined ? Number(row.estimateMax) : null;

      const imageAssets = buildLotImageAssetContract(
        typeof row.imageUrl === 'string' ? row.imageUrl : null,
        this.assetsBaseUrl,
      );
      const verifiedAt = row.assetVerifiedAt && Number.isFinite(Date.parse(row.assetVerifiedAt))
        ? new Date(row.assetVerifiedAt).toISOString()
        : null;
      const assetStatus = row.assetStatus === 'available' && imageAssets.imageUrl && verifiedAt
        ? 'available'
        : (row.assetStatus === 'unavailable' ? 'unavailable' : 'unknown');
      const imageUrl = assetStatus === 'available' ? imageAssets.imageUrl : null;
      const sourceUrl = deriveInvaluableLotUrl({
        sourceUrl: row.sourceUrl || null,
        title: row.title || null,
        lotRef: row.lotRef || null,
        lotNumber: row.lotNumber || null,
      });
      const lot: AuctionDataApiLot = {
        lotUid: String(row.lotUid),
        lotRef: row.lotRef || null,
        title: row.title || null,
        description: row.description || null,
        houseName: row.houseName || null,
        auctionDate,
        priceRealised: price,
        currency,
        currencySymbol,
        estimateMin,
        estimateMax,
        lotNumber: row.lotNumber || null,
        saleType: row.saleType || null,
        sourceUrl,
        rankingScore: row.rankingScore == null ? null : Number(row.rankingScore),
        imagePath: assetStatus === 'available' ? imageAssets.imagePath : null,
        imageFileName: row.imageFileName || null,
        imageUrl,
        assetStatus,
        assetVerifiedAt: assetStatus === 'available' ? verifiedAt : null,
      };
      toCanonicalComparableLot(lot);
      return lot;
    });
  }

  buildAssetUrl(path: string | null): string | null {
    return buildPublicAssetUrl(path, this.assetsBaseUrl);
  }
}
