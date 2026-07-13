import {
  validateComparableLot,
  type CanonicalComparableLotV1,
} from '@appraisily/auction-contracts';

type CurrencyCode = string | null | undefined;
type NullableString = string | null | undefined;

export type ScraperDbSearchParams = {
  query: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
};

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
  imagePath: string | null;
  imageFileName: string | null;
};

export function toCanonicalComparableLot(lot: ScraperDbLot): CanonicalComparableLotV1 {
  const comparable: CanonicalComparableLotV1 = {
    schemaVersion: 1,
    lotUid: lot.lotUid,
    title: lot.title,
    description: lot.description,
    houseName: lot.houseName,
    auctionDate: lot.auctionDate,
    priceRealised: lot.priceRealised,
    currency: lot.currency,
    estimateMin: lot.estimateMin,
    estimateMax: lot.estimateMax,
    sourceUrl: lot.sourceUrl,
  };
  return validateComparableLot(comparable);
}

function normalizeBaseUrl(value: string | undefined | null, fallback: string): string {
  const raw = (value || '').trim();
  if (!raw) return fallback;
  return raw.replace(/\/+$/, '');
}

function toSafeLotNumber(value: NullableString): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^0-9A-Za-z]+/g, '');
  return safe ? safe : null;
}

function normalizeImageFileName(value: NullableString): { base: string; ext: string } | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const stripped = raw.split('?')[0].split('#')[0];
  const clean = stripped.replace(/\\/g, '/').split('/').pop() || '';
  if (!clean) return null;
  const idx = clean.lastIndexOf('.');
  if (idx <= 0 || idx === clean.length - 1) return null;
  const base = clean.slice(0, idx);
  const ext = clean.slice(idx + 1);
  if (!base || !ext) return null;
  return { base, ext };
}

export function isPublishedAssetPath(relativePath: NullableString): boolean {
  const clean = String(relativePath || '').trim().replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const segments = clean.split('/').filter(Boolean);
  return segments[0] === 'auction-lots'
    && segments.length >= 3
    && !segments.some((segment) => segment === '.' || segment === '..');
}

function buildScraperDbPublishedImagePath(opts: {
  srcPath: NullableString;
  imageFileName: NullableString;
  lotNumber: NullableString;
}): string | null {
  const lotNumber = toSafeLotNumber(opts.lotNumber);
  if (!lotNumber) return null;

  const src = String(opts.srcPath || '').trim().replace(/\\/g, '/').replace(/^[\\/]+/, '');
  if (!src || src.startsWith('gs://')) return null;
  if (src.startsWith('auction-lots/')) {
    return isPublishedAssetPath(src) ? src : null;
  }

  const category = (() => {
    const match = src.match(/^([^/]+)\/images\//);
    return match ? match[1] : null;
  })();
  if (!category || !/^[A-Za-z0-9._-]+$/.test(category)) return null;

  const file = normalizeImageFileName(opts.imageFileName) || normalizeImageFileName(src);
  if (!file) return null;

  const [primary, ...suffixParts] = file.base.split('__');
  const baseNormalized = [String(primary || '').toUpperCase(), ...suffixParts].filter(Boolean).join('__');
  const extLower = String(file.ext || '').toLowerCase();
  if (!baseNormalized || !extLower) return null;

  const fileName = `${lotNumber}_${baseNormalized}.${extLower}`;
  return `auction-lots/scraper-db/${category}/images/${fileName}`;
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

  constructor() {
    this.dataApiUrl = normalizeBaseUrl(
      process.env.AUCTION_DATA_API_URL,
      'http://scraper-orchestrator:8080',
    );
    this.dataApiKey = String(process.env.AUCTION_DATA_API_KEY || process.env.INGEST_API_KEY || '').trim();
    if (!this.dataApiKey) throw new Error('Missing AUCTION_DATA_API_KEY');

    this.assetsBaseUrl = normalizeBaseUrl(
      process.env.PUBLIC_ASSETS_BASE_URL || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC || process.env.LOCAL_STORAGE_BASE_URL,
      'https://assets.appraisily.com',
    );
  }

  async close(): Promise<void> {}

  async searchLots(params: ScraperDbSearchParams): Promise<ScraperDbLot[]> {
    const query = String(params.query || '').trim();
    if (!query) return [];
    const limit = Math.max(1, Math.min(200, Number(params.limit || 50)));
    const minPrice = Number.isFinite(params.minPrice as number) ? Number(params.minPrice) : null;
    const maxPrice = Number.isFinite(params.maxPrice as number) ? Number(params.maxPrice) : null;

    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Number(process.env.AUCTION_DATA_API_TIMEOUT_MS || 10_000));
    const timeout = setTimeout(() => controller.abort(new Error('auction_data_api_timeout')), timeoutMs);
    let rows: any[];
    try {
      const response = await fetch(`${this.dataApiUrl}/api/v1/comparables/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.dataApiKey,
        },
        body: JSON.stringify({ query, minPrice, maxPrice, limit }),
        signal: controller.signal,
      });
      const payload = await response.json() as { success?: boolean; lots?: any[]; error?: string };
      if (!response.ok || payload.success !== true || !Array.isArray(payload.lots)) {
        throw new Error(payload.error || `auction_data_api_${response.status}`);
      }
      rows = payload.lots;
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

      const rawImagePath = (row.imagePath || null) as string | null;
      const publishedImagePath = buildScraperDbPublishedImagePath({
        srcPath: rawImagePath,
        imageFileName: row.imageFileName || null,
        lotNumber: row.lotNumber || null,
      });
      const imagePath = publishedImagePath
        || (isPublishedAssetPath(rawImagePath) ? rawImagePath : null)
        || rawImagePath;
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
        imagePath,
        imageFileName: row.imageFileName || null,
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
