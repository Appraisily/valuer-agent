import {
  validateComparableLot,
  type CanonicalComparableLotV1,
} from '@appraisily/auction-contracts';
import { recordUpstreamSearch } from './metrics.js';

type CurrencyCode = string | null | undefined;
type NullableString = string | null | undefined;

export type ScraperDbSearchParams = {
  query: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
};

export type ScraperDbSearchOptions = {
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

export type ScraperDbLot = {
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

export function toCanonicalComparableLot(lot: ScraperDbLot): CanonicalComparableLotV1 {
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
  const clean = String(relativePath || '').trim().replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const segments = clean.split('/').filter(Boolean);
  return segments[0] === 'auction-lots'
    && segments.length >= 3
    && !segments.some((segment) => segment === '.' || segment === '..');
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

export function buildPublicAssetUrl(relativePath: string | null): string | null {
  const clean = normalizePublicAssetPath(relativePath);
  if (!clean) return null;
  const base = normalizeBaseUrl(
    process.env.PUBLIC_ASSETS_BASE_URL || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC || process.env.LOCAL_STORAGE_BASE_URL,
    'https://assets.appraisily.com',
  );
  const safe = clean
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `${base}/${safe}`;
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

function normalizePublicAssetPath(relativePath: NullableString): string | null {
  const raw = String(relativePath || '').trim();
  if (!raw || raw.startsWith('gs://')) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const configuredBase = normalizeBaseUrl(
        process.env.PUBLIC_ASSETS_BASE_URL || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC || process.env.LOCAL_STORAGE_BASE_URL,
        'https://assets.appraisily.com',
      );
      const configuredHost = new URL(configuredBase).host.toLowerCase();
      const host = url.host.toLowerCase();
      if (host !== 'assets.appraisily.com' && host !== configuredHost) return null;
      return decodeURIComponent(url.pathname).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    } catch {
      return null;
    }
  }

  let clean = raw.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (clean.startsWith('public/')) clean = clean.slice('public/'.length);
  if (clean.startsWith('storage/public/')) clean = clean.slice('storage/public/'.length);
  return clean.startsWith('auction-lots/') ? clean : null;
}

export function buildLotImageAssetContract(relativePath: NullableString): LotImageAssetContract {
  const clean = normalizePublicAssetPath(relativePath);
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

  const variantMatch = clean.match(/^auction-lots\/[^/]+\/(thumb|medium|original)\//);
  const currentVariant = variantMatch?.[1] || null;
  const thumbPath = currentVariant === 'thumb'
    ? clean
    : clean;
  const mediumPath = currentVariant === 'medium'
    ? clean
    : clean;
  const originalPath = currentVariant === 'original'
    ? clean
    : clean;

  const imagePath = originalPath || mediumPath || thumbPath || clean;
  const thumbUrl = buildPublicAssetUrl(thumbPath || imagePath);
  const imageUrl = buildPublicAssetUrl(mediumPath || thumbPath || imagePath);
  const originalUrl = buildPublicAssetUrl(originalPath || imagePath);

  return {
    imagePath,
    thumbPath,
    mediumPath,
    originalPath,
    thumbUrl,
    imageUrl,
    originalUrl,
    imageOriginalUrl: originalUrl,
  };
}

export class ScraperDbClient {
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

  async searchLots(params: ScraperDbSearchParams, options: ScraperDbSearchOptions = {}): Promise<ScraperDbLot[]> {
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

      const assetStatus = ['available', 'unavailable'].includes(row.assetStatus) ? row.assetStatus : 'unknown';
      const imageUrl = assetStatus === 'available' && typeof row.imageUrl === 'string' ? row.imageUrl : null;
      const sourceUrl = deriveInvaluableLotUrl({
        sourceUrl: row.sourceUrl || null,
        title: row.title || null,
        lotRef: row.lotRef || null,
        lotNumber: row.lotNumber || null,
      });
      const lot: ScraperDbLot = {
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
        imagePath: imageUrl,
        imageFileName: row.imageFileName || null,
        imageUrl,
        assetStatus,
        assetVerifiedAt: row.assetVerifiedAt || null,
      };
      toCanonicalComparableLot(lot);
      return lot;
    });
  }

  buildAssetUrl(path: string | null): string | null {
    if (!path) return null;
    const trimmed = String(path).trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('gs://')) return null;
    let clean = trimmed.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    if (clean.startsWith('public/')) clean = clean.slice('public/'.length);
    if (clean.startsWith('storage/public/')) clean = clean.slice('storage/public/'.length);
    if (!clean.startsWith('auction-lots/')) return null;
    const safe = clean
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.assetsBaseUrl}/${safe}`;
  }
}
