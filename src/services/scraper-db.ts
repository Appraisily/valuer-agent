import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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

function normalizeMediaRoot(value: NullableString): string {
  const raw = String(value || '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

const DEFAULT_MEDIA_ROOT = '/mnt/srv-storage/scrapper-db-data/data';
const DEFAULT_PUBLIC_ASSETS_ROOT = '/mnt/srv-storage/storage/public';
const categoryIndexCache = new Map<string, Promise<Set<string>>>();

async function getCategoryIndex(mediaRoot: string): Promise<Set<string>> {
  const root = normalizeMediaRoot(mediaRoot) || DEFAULT_MEDIA_ROOT;
  const cached = categoryIndexCache.get(root);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const categories = new Set<string>();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = String(entry.name || '').trim();
        if (!name) continue;
        categories.add(name);
      }
      return categories;
    } catch {
      return new Set<string>();
    }
  })();
  categoryIndexCache.set(root, promise);
  return promise;
}

const fileExistsCache = new Map<string, boolean>();
const FILE_EXISTS_CACHE_MAX = 10_000;

function cachedExists(filePath: string): boolean {
  const hit = fileExistsCache.get(filePath);
  if (typeof hit === 'boolean') return hit;
  const exists = fs.existsSync(filePath);
  if (fileExistsCache.size >= FILE_EXISTS_CACHE_MAX) fileExistsCache.clear();
  fileExistsCache.set(filePath, exists);
  return exists;
}

function normalizePublicAssetsRoot(value: NullableString): string {
  const raw = String(value || process.env.PUBLIC_STORAGE_ROOT || DEFAULT_PUBLIC_ASSETS_ROOT).trim();
  return raw ? raw.replace(/\/+$/, '') : DEFAULT_PUBLIC_ASSETS_ROOT;
}

export function isPublishedAssetPath(relativePath: NullableString): boolean {
  const clean = String(relativePath || '').trim().replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return clean.startsWith('auction-lots/');
}

function resolvePublishedAssetAbsolutePath(relativePath: NullableString, publicRoot?: NullableString): string | null {
  if (!isPublishedAssetPath(relativePath)) return null;
  const clean = String(relativePath || '').trim().replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const root = normalizePublicAssetsRoot(publicRoot);
  const resolved = path.resolve(root, clean);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) return null;
  return resolved;
}

export function publishedAssetExists(relativePath: NullableString, publicRoot?: NullableString): boolean {
  const absolutePath = resolvePublishedAssetAbsolutePath(relativePath, publicRoot);
  if (!absolutePath) return false;
  return cachedExists(absolutePath);
}

function buildScraperDbPublishedImagePath(opts: {
  srcPath: NullableString;
  imageFileName: NullableString;
  lotNumber: NullableString;
  mediaRoot: string;
  categories: Set<string>;
}): string | null {
  const lotNumber = toSafeLotNumber(opts.lotNumber);
  if (!lotNumber) return null;

  const src = String(opts.srcPath || '').trim().replace(/\\/g, '/').replace(/^[\\/]+/, '');
  if (!src || src.startsWith('gs://')) return null;
  if (src.startsWith('auction-lots/')) {
    return publishedAssetExists(src) ? src : null;
  }

  const category = (() => {
    const match = src.match(/^([^/]+)\/images\//);
    return match ? match[1] : null;
  })();
  if (!category) return null;
  if (!opts.categories.has(category)) return null;

  const file = normalizeImageFileName(opts.imageFileName) || normalizeImageFileName(src);
  if (!file) return null;

  const [primary, ...suffixParts] = file.base.split('__');
  const baseNormalized = [String(primary || '').toUpperCase(), ...suffixParts].filter(Boolean).join('__');
  const extLower = String(file.ext || '').toLowerCase();
  if (!baseNormalized || !extLower) return null;

  const fileName = `${lotNumber}_${baseNormalized}.${extLower}`;
  const absolutePath = path.join(opts.mediaRoot || DEFAULT_MEDIA_ROOT, category, 'images', fileName);
  if (!cachedExists(absolutePath)) return null;

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

function lotVariantPath(relativePath: string, variant: 'thumb' | 'medium' | 'original'): string | null {
  const match = relativePath.match(/^(auction-lots\/[^/]+)\/(thumb|medium|original)\/(.+)$/);
  if (!match) return null;
  return `${match[1]}/${variant}/${match[3]}`;
}

function existingVariantPath(relativePath: string, variant: 'thumb' | 'medium' | 'original'): string | null {
  const candidate = lotVariantPath(relativePath, variant);
  if (!candidate) return null;
  return publishedAssetExists(candidate) ? candidate : null;
}

export function buildLotImageAssetContract(relativePath: NullableString): LotImageAssetContract {
  const clean = normalizePublicAssetPath(relativePath);
  if (!clean || !publishedAssetExists(clean)) {
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
  const currentExists = publishedAssetExists(clean);

  const thumbPath = currentVariant === 'thumb'
    ? clean
    : (existingVariantPath(clean, 'thumb') || (currentExists || !currentVariant ? clean : null));
  const mediumPath = currentVariant === 'medium'
    ? clean
    : (existingVariantPath(clean, 'medium') || thumbPath || (currentExists ? clean : null));
  const originalPath = currentVariant === 'original'
    ? clean
    : (existingVariantPath(clean, 'original') || (currentExists ? clean : mediumPath || thumbPath));

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
    const mediaRoot = normalizeMediaRoot(process.env.SCRAPER_DB_MEDIA_ROOT) || DEFAULT_MEDIA_ROOT;
    const categories = await getCategoryIndex(mediaRoot);

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
        mediaRoot,
        categories,
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
