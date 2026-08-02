'use strict';

const LOT_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:avif|jpe?g|png|webp)$/i;
const CANONICAL_ASSETS_ORIGIN = 'https://assets.appraisily.com';

function normalizePublicAuctionLotUid(value) {
  const normalized = String(value ?? '').trim();
  return LOT_UID_PATTERN.test(normalized) ? normalized : null;
}

function normalizePublicAuctionImagePath(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.startsWith('/') || raw.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.length !== 4 || parts.some(part => !part || part === '.' || part === '..')) return null;
  if (parts[0] !== 'auction-lots' || parts[2] !== 'thumb') return null;
  if (!normalizePublicAuctionLotUid(parts[1]) || !FILE_NAME_PATTERN.test(parts[3])) return null;
  return parts.join('/');
}

function buildPublicAuctionImagePath({ lotUid, filename } = {}) {
  const safeLotUid = normalizePublicAuctionLotUid(lotUid);
  const safeFilename = String(filename ?? '').trim();
  if (!safeLotUid || !FILE_NAME_PATTERN.test(safeFilename)) return null;
  return normalizePublicAuctionImagePath(`auction-lots/${safeLotUid}/thumb/${safeFilename}`);
}

function normalizeAssetsOrigin(value = CANONICAL_ASSETS_ORIGIN) {
  try {
    const parsed = new URL(String(value || CANONICAL_ASSETS_ORIGIN));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildPublicAuctionImageUrl(relativePath, baseUrl = CANONICAL_ASSETS_ORIGIN) {
  const canonicalPath = normalizePublicAuctionImagePath(relativePath);
  const origin = normalizeAssetsOrigin(baseUrl);
  if (!canonicalPath || !origin) return null;
  const encodedPath = canonicalPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `${origin}/${encodedPath}`;
}

function normalizePublicAuctionImageUrl(value, expectedOrigin = CANONICAL_ASSETS_ORIGIN) {
  const origin = normalizeAssetsOrigin(expectedOrigin);
  if (!origin) return null;
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.origin !== origin || parsed.search || parsed.hash) return null;
    const canonicalPath = normalizePublicAuctionImagePath(decodeURIComponent(parsed.pathname.replace(/^\/+/, '')));
    return canonicalPath ? buildPublicAuctionImageUrl(canonicalPath, origin) : null;
  } catch {
    return null;
  }
}

module.exports = {
  CANONICAL_ASSETS_ORIGIN,
  buildPublicAuctionImagePath,
  buildPublicAuctionImageUrl,
  normalizeAssetsOrigin,
  normalizePublicAuctionImagePath,
  normalizePublicAuctionImageUrl,
  normalizePublicAuctionLotUid,
};
