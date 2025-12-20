import pg from 'pg';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

type CurrencyCode = string | null | undefined;
type NullableString = string | null | undefined;

const QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

// Very common lot/title tokens that should not be treated as "anchors" (artist/maker tokens).
const QUERY_COMMON_TOKENS = new Set([
  'acrylic',
  'artist',
  'canvas',
  'ceramic',
  'china',
  'etching',
  'frame',
  'framed',
  'giclee',
  'hand',
  'lithograph',
  'mixed',
  'oil',
  'original',
  'paint',
  'painting',
  'paper',
  'print',
  'serigraph',
  'signed',
  'sketch',
  'watercolor',
]);

function tokenizeQuery(value: string): string[] {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildAnchorTsQueries(query: string): { must: string | null; optionalOr: string | null } {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return { must: null, optionalOr: null };

  const anchors: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) break;
    if (QUERY_STOPWORDS.has(token)) break;
    if (QUERY_COMMON_TOKENS.has(token)) break;
    if (/^\d+$/.test(token)) break;
    anchors.push(token);
    if (anchors.length >= 2) break;
  }

  if (!anchors.length) return { must: null, optionalOr: null };

  const optional: string[] = [];
  const optionalSeen = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (QUERY_STOPWORDS.has(token)) continue;
    if (anchors.includes(token)) continue;
    const key = token.toLowerCase();
    if (optionalSeen.has(key)) continue;
    optionalSeen.add(key);
    optional.push(token);
    if (optional.length >= 8) break;
  }

  const must = anchors.map((t) => `${t}:*`).join(' & ');
  const optionalOr = optional.length ? optional.map((t) => `${t}:*`).join(' | ') : null;
  return { must, optionalOr };
}

export type ScraperDbSearchParams = {
  query: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
};

export type ScraperDbLot = {
  lotUid: string;
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
  if (src.startsWith('auction-lots/')) return src;

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

export function buildPublicAssetUrl(relativePath: string | null): string | null {
  if (!relativePath) return null;
  const trimmed = String(relativePath).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('gs://')) return null;

  const base = normalizeBaseUrl(
    process.env.PUBLIC_ASSETS_BASE_URL || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC || process.env.LOCAL_STORAGE_BASE_URL,
    'https://assets.appraisily.com',
  );

  let clean = trimmed.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (clean.startsWith('public/')) clean = clean.slice('public/'.length);
  if (clean.startsWith('storage/public/')) clean = clean.slice('storage/public/'.length);

  // Only emit public URLs for paths we explicitly publish under the assets domain.
  // Everything else (e.g. scraper working buckets like "<keyword>/images/...") should not be
  // exposed as a broken public URL; return null until it is published/backfilled.
  if (!clean.startsWith('auction-lots/')) return null;

  const safe = clean
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `${base}/${safe}`;
}

export class ScraperDbClient {
  private pool: pg.Pool;
  private assetsBaseUrl: string;

  constructor() {
    const connectionString = (
      process.env.SCRAPER_DB_URL
      || process.env.SCRAPER_DATABASE_URL
      || process.env.SCRAPER_DB_CONNECTION_STRING
      || ''
    ).trim();
    if (!connectionString) {
      throw new Error('Missing SCRAPER_DB_URL (or SCRAPER_DATABASE_URL)');
    }

    const sslMode = String(process.env.SCRAPER_DB_SSL ?? '').toLowerCase();
    const ssl = (sslMode === '1' || sslMode === 'true')
      ? { rejectUnauthorized: false }
      : false;

    const queryTimeoutMs = (() => {
      const v = Number(process.env.SCRAPER_DB_QUERY_TIMEOUT_MS);
      if (Number.isFinite(v) && v > 0) return Math.floor(v);
      return 10_000;
    })();

    this.pool = new pg.Pool({
      connectionString,
      ssl,
      query_timeout: queryTimeoutMs,
      max: Math.max(1, Math.min(10, Number(process.env.SCRAPER_DB_POOL_SIZE || 4))),
    });

    this.assetsBaseUrl = normalizeBaseUrl(
      process.env.PUBLIC_ASSETS_BASE_URL || process.env.LOCAL_STORAGE_BASE_URL_PUBLIC || process.env.LOCAL_STORAGE_BASE_URL,
      'https://assets.appraisily.com',
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async searchLots(params: ScraperDbSearchParams): Promise<ScraperDbLot[]> {
    const query = String(params.query || '').trim();
    if (!query) return [];
    const limit = Math.max(1, Math.min(200, Number(params.limit || 50)));
    const minPrice = Number.isFinite(params.minPrice as number) ? Number(params.minPrice) : null;
    const maxPrice = Number.isFinite(params.maxPrice as number) ? Number(params.maxPrice) : null;

    const anchor = buildAnchorTsQueries(query);

    const sql = `
      WITH strict_matches AS (
        SELECT
          l.lot_uid,
          l.title,
          l.description,
          l.house_name,
          l.auction_date,
          l.price_realised,
          l.currency,
          l.currency_symbol,
          l.estimate_min,
          l.estimate_max,
          l.lot_number,
          l.sale_type,
          l.source_url,
          true AS is_strict,
          ts_rank_cd(
            to_tsvector('simple', coalesce(l.title,'') || ' ' || coalesce(l.description,'')),
            plainto_tsquery('simple', $1)
          ) AS rank
        FROM lots l
        WHERE
          to_tsvector('simple', coalesce(l.title,'') || ' ' || coalesce(l.description,'')) @@ plainto_tsquery('simple', $1)
          AND l.price_realised IS NOT NULL
          AND l.price_realised > 0
          AND ($2::numeric IS NULL OR l.price_realised >= $2)
          AND ($3::numeric IS NULL OR l.price_realised <= $3)
        ORDER BY rank DESC, l.auction_date DESC NULLS LAST, l.lot_uid DESC
        LIMIT $4
      ),
      anchor_matches AS (
        SELECT
          l.lot_uid,
          l.title,
          l.description,
          l.house_name,
          l.auction_date,
          l.price_realised,
          l.currency,
          l.currency_symbol,
          l.estimate_min,
          l.estimate_max,
          l.lot_number,
          l.sale_type,
          l.source_url,
          false AS is_strict,
          (
            ts_rank_cd(
              to_tsvector('simple', coalesce(l.title,'') || ' ' || coalesce(l.description,'')),
              CASE
                WHEN $5::text IS NULL OR btrim($5) = '' THEN NULL
                ELSE to_tsquery('simple', $5)
              END
            ) * 2.0
            + (
              CASE
                WHEN $6::text IS NULL OR btrim($6) = '' THEN 0
                ELSE ts_rank_cd(
                  to_tsvector('simple', coalesce(l.title,'') || ' ' || coalesce(l.description,'')),
                  to_tsquery('simple', $6)
                ) * 0.15
              END
            )
          ) AS rank
        FROM lots l
        WHERE
          to_tsvector('simple', coalesce(l.title,'') || ' ' || coalesce(l.description,'')) @@ (
            CASE
              WHEN $5::text IS NULL OR btrim($5) = '' THEN NULL
              ELSE to_tsquery('simple', $5)
            END
          )
          AND l.price_realised IS NOT NULL
          AND l.price_realised > 0
          AND ($2::numeric IS NULL OR l.price_realised >= $2)
          AND ($3::numeric IS NULL OR l.price_realised <= $3)
          AND NOT EXISTS (SELECT 1 FROM strict_matches s WHERE s.lot_uid = l.lot_uid)
        ORDER BY rank DESC, l.auction_date DESC NULLS LAST, l.lot_uid DESC
        LIMIT GREATEST(0, $4 - (SELECT COUNT(*) FROM strict_matches))
      ),
      ranked AS (
        SELECT * FROM strict_matches
        UNION ALL
        SELECT * FROM anchor_matches
      )
      SELECT
        r.lot_uid,
        r.title,
        r.description,
        r.house_name,
        r.auction_date,
        r.price_realised,
        r.currency,
        r.currency_symbol,
        r.estimate_min,
        r.estimate_max,
        r.lot_number,
        r.sale_type,
        r.source_url,
        lead_img.image_filename AS image_filename,
        lead_img.src_path AS image_src_path,
        lead_img.gcs_path AS image_gcs_path
      FROM ranked r
      LEFT JOIN LATERAL (
        SELECT i.image_filename, i.src_path, i.gcs_path
        FROM images i
        WHERE i.lot_uid = r.lot_uid
        ORDER BY i.ordinal NULLS LAST, i.image_filename
        LIMIT 1
      ) AS lead_img ON TRUE
      ORDER BY r.is_strict DESC, r.rank DESC, r.auction_date DESC NULLS LAST, r.lot_uid DESC
    `;

    const result = await this.pool.query(sql, [query, minPrice, maxPrice, limit, anchor.must, anchor.optionalOr]);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const mediaRoot = normalizeMediaRoot(process.env.SCRAPER_DB_MEDIA_ROOT) || DEFAULT_MEDIA_ROOT;
    const categories = await getCategoryIndex(mediaRoot);

    return rows.map((row: any) => {
      const auctionDate = row.auction_date ? new Date(row.auction_date).toISOString() : null;
      const currency = row.currency || null;
      const currencySymbol = row.currency_symbol || currencyToSymbol(currency);
      const price = row.price_realised !== null && row.price_realised !== undefined
        ? Number(row.price_realised)
        : null;
      const estimateMin = row.estimate_min !== null && row.estimate_min !== undefined ? Number(row.estimate_min) : null;
      const estimateMax = row.estimate_max !== null && row.estimate_max !== undefined ? Number(row.estimate_max) : null;

      const rawImagePath = (row.image_src_path || row.image_gcs_path || null) as string | null;
      const publishedImagePath = buildScraperDbPublishedImagePath({
        srcPath: rawImagePath,
        imageFileName: row.image_filename || null,
        lotNumber: row.lot_number || null,
        mediaRoot,
        categories,
      });
      const imagePath = publishedImagePath || rawImagePath;
      return {
        lotUid: String(row.lot_uid),
        title: row.title || null,
        description: row.description || null,
        houseName: row.house_name || null,
        auctionDate,
        priceRealised: price,
        currency,
        currencySymbol,
        estimateMin,
        estimateMax,
        lotNumber: row.lot_number || null,
        saleType: row.sale_type || null,
        sourceUrl: row.source_url || null,
        imagePath,
        imageFileName: row.image_filename || null,
      };
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
