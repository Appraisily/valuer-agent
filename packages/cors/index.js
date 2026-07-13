function normalizeAllowedOriginEntry(origin) {
  if (!origin || typeof origin !== 'string') return null;
  const raw = origin.trim();
  if (!raw) return null;

  if (raw === '*') return null;

  if (raw.startsWith('*.')) return `.${raw.slice(2).toLowerCase()}`;
  if (raw.startsWith('.')) return raw.toLowerCase();

  if (raw.includes('://')) {
    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
      if (!hostname) return null;
      return parsed.port ? `${hostname}:${parsed.port}` : hostname;
    } catch (_) {
      return null;
    }
  }

  return raw.toLowerCase();
}

function parseAllowedOrigins(input) {
  return String(input || '')
    .split(',')
    .map((entry) => normalizeAllowedOriginEntry(entry))
    .filter(Boolean);
}

const REQUIRED_ORIGINS = ['appraisily.com', '.appraisily.com'];

const DEFAULT_ALLOWED_ORIGINS = [
  ...REQUIRED_ORIGINS,
  'localhost',
  'localhost:3000',
  'localhost:5173',
  '127.0.0.1',
  '::1',
  // Cloud Run domain suffix is only needed in development/staging —
  // never expose the broad *.run.app wildcard in production.
  ...(['production'].includes(String(process.env.NODE_ENV || '').toLowerCase()) ? [] : ['.run.app']),
];

function loadAllowedOrigins({
  envVarName = 'CORS_ALLOWED_ORIGINS',
  defaults = DEFAULT_ALLOWED_ORIGINS,
  required = REQUIRED_ORIGINS,
  logger,
} = {}) {
  const log = logger || console;
  const raw = String(process.env[envVarName] || '').trim();

  const envOrigins = raw ? parseAllowedOrigins(raw) : [];
  const merged = [...(Array.isArray(defaults) ? defaults : []), ...envOrigins, ...(Array.isArray(required) ? required : [])]
    .map((entry) => normalizeAllowedOriginEntry(entry))
    .filter(Boolean);

  const unique = Array.from(new Set(merged));

  // Hard safety net: never return an empty allowlist (that would brick the frontend).
  if (!unique.length) {
    const fallback = Array.from(new Set(DEFAULT_ALLOWED_ORIGINS.map((entry) => normalizeAllowedOriginEntry(entry)).filter(Boolean)));
    if (log?.warn) log.warn('[cors] allowlist empty; falling back to defaults', { envVarName });
    return fallback;
  }

  if (log?.info) {
    log.info('[cors] allowed origins loaded', { envVarName, allowedOrigins: unique });
  }

  return unique;
}

function originMatchesAllowed(originUrl, allowedEntry) {
  if (!allowedEntry) return false;
  if (allowedEntry === '*') return false;

  const hostname = originUrl.hostname.toLowerCase().replace(/\.+$/, '');
  const hostWithPort = originUrl.port ? `${hostname}:${originUrl.port}` : hostname;

  if (allowedEntry.startsWith('.')) {
    return hostname.endsWith(allowedEntry);
  }

  if (allowedEntry.includes(':')) {
    return hostWithPort === allowedEntry;
  }

  return hostname === allowedEntry || hostname.endsWith(`.${allowedEntry}`);
}

function isOriginAllowed(originHeader, allowedOrigins, { allowNoOrigin = true } = {}) {
  if (!originHeader) return Boolean(allowNoOrigin);
  if (originHeader === 'null') return false;

  let parsed;
  try {
    parsed = new URL(originHeader);
  } catch (_) {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  return (allowedOrigins || []).some((entry) => originMatchesAllowed(parsed, entry));
}

function createCorsMiddleware({
  envVarName = 'CORS_ALLOWED_ORIGINS',
  logger,
  defaults,
  required,
  allowNoOrigin = true,
  credentials = true,
  methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAgeSeconds = 600,
} = {}) {
  const allowedOrigins = loadAllowedOrigins({ envVarName, defaults, required, logger });
  const log = logger || console;

  function setCommonHeaders(req, res, origin) {
    res.setHeader('Vary', 'Origin');
    if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', origin);

    const requestHeaders = req.headers['access-control-request-headers'];
    if (requestHeaders) {
      res.setHeader('Access-Control-Allow-Headers', String(requestHeaders));
    }
    res.setHeader('Access-Control-Allow-Methods', methods.join(','));
    res.setHeader('Access-Control-Max-Age', String(maxAgeSeconds));
  }

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin ? String(req.headers.origin) : '';

    if (!origin) return next();

    if (!isOriginAllowed(origin, allowedOrigins, { allowNoOrigin })) {
      if (log?.warn) log.warn('[cors] blocked origin', { origin, path: req.originalUrl || req.url });
      // For preflight: fail fast so the browser gets a clear rejection.
      if (req.method === 'OPTIONS') return res.status(403).end();
      return next();
    }

    setCommonHeaders(req, res, origin);

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    return next();
  };
}

module.exports = {
  DEFAULT_ALLOWED_ORIGINS,
  REQUIRED_ORIGINS,
  normalizeAllowedOriginEntry,
  parseAllowedOrigins,
  loadAllowedOrigins,
  isOriginAllowed,
  createCorsMiddleware,
};

