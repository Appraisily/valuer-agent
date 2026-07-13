'use strict';

function normalizeRelativePath(relative = '') {
  return String(relative || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\s+/g, ' ');
}

function normalizeStorageUri(uri) {
  if (!uri) return null;
  return String(uri).replace(/\\/g, '/').replace(/ /g, '%20');
}

function canonicalizeAssetUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    const host = (parsed.hostname || '').toLowerCase();
    if (host !== 'assets.appraisily.com') return url;

    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }

    if (parsed.port === '8080') {
      parsed.port = '';
    }

    const segments = (parsed.pathname || '')
      .split('/')
      .filter(Boolean);

    // Legacy bucket mirrors → canonical public layout.
    const legacyPrefixes = ['appraisily-public-reports', 'appraisers-backend'];
    if (segments.length >= 1 && legacyPrefixes.includes(segments[0])) {
      parsed.pathname = `/${segments.slice(1).join('/')}`;
      return parsed.toString();
    }

    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function buildBucketUrl(bucket, objectPath = '') {
  if (!bucket) return null;
  const base = process.env.STORAGE_BUCKET_BASE_URL || 'https://storage.googleapis.com';
  const safe = normalizeRelativePath(objectPath);
  const built = normalizeStorageUri(`${base.replace(/\/+$/, '')}/${bucket}/${safe}`);
  return canonicalizeAssetUrl(built);
}

function detectBucketUrl(url) {
  if (!url) return null;
  const value = String(url);
  if (value.startsWith('gs://')) {
    const withoutScheme = value.slice(5);
    const parts = withoutScheme.split('/');
    const bucket = parts.shift();
    return { bucket, objectPath: parts.join('/') };
  }
  const match = value.match(/^https?:\/\/storage\.googleapis\.com\/([^\/]+)\/(.+)$/i);
  if (match) {
    return { bucket: match[1], objectPath: match[2] };
  }
  return null;
}

function buildPublicAssetUrl(relativePath) {
  if (!relativePath) return null;
  const base = process.env.PUBLIC_ASSETS_BASE_URL || process.env.LOCAL_STORAGE_BASE_URL || '';
  if (!base) {
    return normalizeStorageUri(relativePath);
  }
  const safe = normalizeRelativePath(relativePath);
  return canonicalizeAssetUrl(normalizeStorageUri(`${base.replace(/\/+$/, '')}/${safe}`));
}

module.exports = {
  normalizeStorageUri,
  canonicalizeAssetUrl,
  buildBucketUrl,
  detectBucketUrl,
  buildPublicAssetUrl
};

