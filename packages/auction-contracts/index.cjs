'use strict';

const publicAuctionImage = require('./public-auction-image.cjs');

const CONTRACT_VERSIONS = Object.freeze({
  pageArtifact: 1, validEmptyArtifact: 1, scrapeJobRequest: 1, scrapeJobStatus: 1,
  scrapeJobResult: 1, pageAudit: 1, noveltyDecision: 1, ingestCommand: 1,
  ingestResult: 1, thumbnailPublishRequest: 1, thumbnailPublishResult: 1, comparableLot: 1,
  auctionSearchRequest: 1, auctionSearchResponse: 1,
});
const INGEST_COMMAND_TERMINAL_STATUSES = Object.freeze(['success', 'partial', 'permanent_failure', 'rejected_invalid_artifact']);
const INGEST_COMMAND_STATUSES = Object.freeze(['pending', 'running', 'retryable_failure', ...INGEST_COMMAND_TERMINAL_STATUSES]);
const SCRAPE_JOB_STATUSES = Object.freeze(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SUBJECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class AuctionContractError extends TypeError {
  constructor(contract, message, { code = 'INVALID_CONTRACT' } = {}) {
    super(`${contract}: ${message}`);
    this.name = 'AuctionContractError';
    this.contract = contract;
    this.code = code;
  }
}

function object(value, contract, field = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuctionContractError(contract, `${field} must be an object`);
  return value;
}
function string(value, contract, field, { max = 1000, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new AuctionContractError(contract, `${field} is required`);
  if (normalized.length > max) throw new AuctionContractError(contract, `${field} exceeds ${max} characters`);
  return normalized;
}
function number(value, contract, field, { integer = false, min = -Infinity, max = Infinity, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || (integer && !Number.isInteger(normalized)) || normalized < min || normalized > max) throw new AuctionContractError(contract, `${field} is invalid`);
  return normalized;
}
function enumeration(value, allowed, contract, field) {
  const normalized = string(value, contract, field);
  if (!allowed.includes(normalized)) throw new AuctionContractError(contract, `${field} has unsupported value ${normalized}`);
  return normalized;
}
function stringArray(value, contract, field, { maxItems = 20, maxLength = 200 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new AuctionContractError(contract, `${field} must contain at most ${maxItems} values`);
  value.forEach((item, index) => string(item, contract, `${field}[${index}]`, { max: maxLength }));
  return value;
}
function onlyFields(value, allowed, contract, field = 'payload') {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new AuctionContractError(contract, `${field}.${key} is unsupported`);
  }
}
function isoTimestamp(value, contract, field) {
  const normalized = string(value, contract, field, { max: 64 });
  if (!Number.isFinite(Date.parse(normalized))) throw new AuctionContractError(contract, `${field} must be an ISO timestamp`);
  return new Date(normalized).toISOString();
}
function version(input, contract) {
  const expected = CONTRACT_VERSIONS[contract];
  const actual = Number(input?.schemaVersion);
  if (actual !== expected) throw new AuctionContractError(contract, `unsupported schemaVersion ${input?.schemaVersion ?? 'missing'}; supported=${expected}`, { code: 'UNSUPPORTED_SCHEMA_VERSION' });
  return actual;
}
function safeReference(value, contract, field) {
  const normalized = string(value, contract, field);
  if (normalized.startsWith('/') || normalized.split(/[\\/]/).includes('..')) throw new AuctionContractError(contract, `${field} must be a storage-relative path`);
  return normalized.replace(/\\/g, '/');
}

function validatePageArtifact(input) {
  const contract = 'pageArtifact';
  object(input, contract);
  const marker = object(input._appraisilyPageArtifact, contract, '_appraisilyPageArtifact');
  version(marker, contract);
  const outcome = enumeration(marker.outcome, ['results', 'empty_valid', 'empty_unverified', 'invalid_schema'], contract, 'outcome');
  const lotCount = number(marker.lotCount, contract, 'lotCount', { integer: true, min: 0 });
  const declaredTotal = marker.declaredTotal == null ? null : number(marker.declaredTotal, contract, 'declaredTotal', { integer: true, min: 0 });
  number(marker.pageNumber, contract, 'pageNumber', { integer: true, min: 1 });
  isoTimestamp(marker.recordedAt, contract, 'recordedAt');
  if (outcome === 'results' && lotCount < 1) throw new AuctionContractError(contract, 'results outcome requires at least one lot');
  if (outcome === 'empty_valid' && (lotCount !== 0 || declaredTotal !== 0)) throw new AuctionContractError(contract, 'empty_valid requires lotCount=0 and declaredTotal=0');
  return input;
}
function validateValidEmptyArtifact(input) {
  validatePageArtifact(input);
  const marker = input._appraisilyPageArtifact;
  if (marker.outcome !== 'empty_valid' || Number(marker.lotCount) !== 0 || Number(marker.declaredTotal) !== 0) throw new AuctionContractError('validEmptyArtifact', 'explicit empty_valid marker is required');
  return input;
}
function validateScrapeJobRequest(input) {
  const contract = 'scrapeJobRequest'; object(input, contract); version(input, contract);
  string(input.jobId, contract, 'jobId', { max: 100 }); string(input.idempotencyKey, contract, 'idempotencyKey', { max: 255 });
  string(input.correlationId, contract, 'correlationId', { max: 255 }); string(input.laneId, contract, 'laneId', { max: 200 });
  string(input.query, contract, 'query', { max: 500 }); isoTimestamp(input.requestedAt, contract, 'requestedAt'); return input;
}
function validateScrapeJobStatus(input) {
  const contract = 'scrapeJobStatus'; object(input, contract); version(input, contract);
  string(input.jobId, contract, 'jobId', { max: 100 }); enumeration(input.status, SCRAPE_JOB_STATUSES, contract, 'status');
  isoTimestamp(input.updatedAt, contract, 'updatedAt');
  if (input.correlationId != null) string(input.correlationId, contract, 'correlationId', { max: 255 });
  if (input.laneId != null) string(input.laneId, contract, 'laneId', { max: 200 }); return input;
}
function validateScrapeJobResult(input) {
  const contract = 'scrapeJobResult'; object(input, contract); version(input, contract);
  string(input.jobId, contract, 'jobId', { max: 100 }); enumeration(input.status, ['completed', 'failed', 'cancelled'], contract, 'status');
  isoTimestamp(input.finishedAt, contract, 'finishedAt'); if (input.artifactPath != null) safeReference(input.artifactPath, contract, 'artifactPath'); return input;
}
function validatePageAudit(input) {
  const contract = 'pageAudit'; object(input, contract); version(input, contract);
  string(input.keywordSlug, contract, 'keywordSlug', { max: 200 }); enumeration(input.status, ['ok', 'warn', 'fail'], contract, 'status');
  number(input.pages, contract, 'pages', { integer: true, min: 0 }); if (input.auditedAt != null) isoTimestamp(input.auditedAt, contract, 'auditedAt'); return input;
}
function validateNoveltyDecision(input) {
  const contract = 'noveltyDecision'; object(input, contract); version(input, contract);
  string(input.keyword, contract, 'keyword', { max: 200 }); enumeration(input.decision, ['promote', 'images_only', 'skip'], contract, 'decision');
  if (!Array.isArray(input.eligibleLotUids)) throw new AuctionContractError(contract, 'eligibleLotUids must be an array');
  input.eligibleLotUids.forEach((value, index) => string(value, contract, `eligibleLotUids[${index}]`, { max: 255 })); return input;
}
function validateIngestCommand(input) {
  const contract = 'ingestCommand'; object(input, contract); version(input, contract);
  const commandId = string(input.commandId, contract, 'commandId', { max: 64 });
  if (!UUID_PATTERN.test(commandId)) throw new AuctionContractError(contract, 'commandId must be a UUID');
  string(input.idempotencyKey, contract, 'idempotencyKey', { max: 255 }); string(input.correlationId, contract, 'correlationId', { max: 255 }); isoTimestamp(input.requestedAt, contract, 'requestedAt');
  object(input.caller, contract, 'caller'); string(input.caller.identity, contract, 'caller.identity', { max: 100 }); string(input.caller.laneId, contract, 'caller.laneId', { max: 200 });
  object(input.subject, contract, 'subject'); enumeration(input.subject.type, ['keyword', 'artist'], contract, 'subject.type');
  const subjectId = string(input.subject.id, contract, 'subject.id', { max: 200 }).toLowerCase();
  if (!SAFE_SUBJECT_PATTERN.test(subjectId)) throw new AuctionContractError(contract, 'subject.id is not storage-safe');
  object(input.artifact, contract, 'artifact');
  if (Number(input.artifact.schemaVersion) !== CONTRACT_VERSIONS.pageArtifact) throw new AuctionContractError(contract, `unsupported artifact schemaVersion ${input.artifact.schemaVersion ?? 'missing'}`, { code: 'UNSUPPORTED_SCHEMA_VERSION' });
  string(input.artifact.bucket, contract, 'artifact.bucket', { max: 200 }); safeReference(input.artifact.path, contract, 'artifact.path');
  object(input.audit, contract, 'audit'); enumeration(input.audit.status, ['ok', 'warn'], contract, 'audit.status'); safeReference(input.audit.reference, contract, 'audit.reference');
  object(input.novelty, contract, 'novelty'); enumeration(input.novelty.decision, ['promote', 'images_only', 'skip'], contract, 'novelty.decision'); safeReference(input.novelty.reference, contract, 'novelty.reference'); return input;
}
function validateIngestResult(input) {
  const contract = 'ingestResult'; object(input, contract); version(input, contract);
  string(input.commandId, contract, 'commandId', { max: 64 }); enumeration(input.status, INGEST_COMMAND_STATUSES, contract, 'status');
  number(input.attempts, contract, 'attempts', { integer: true, min: 0 }); if (input.finishedAt != null) isoTimestamp(input.finishedAt, contract, 'finishedAt'); return input;
}
function validateThumbnailPublishRequest(input) {
  const contract = 'thumbnailPublishRequest'; object(input, contract);
  onlyFields(input, ['schemaVersion', 'requestId', 'correlationId', 'lotUids', 'limit', 'maxConcurrency'], contract);
  version(input, contract);
  if (typeof input.requestId !== 'string' || typeof input.correlationId !== 'string') {
    throw new AuctionContractError(contract, 'requestId and correlationId must be strings');
  }
  string(input.requestId, contract, 'requestId', { max: 100 }); string(input.correlationId, contract, 'correlationId', { max: 255 });
  if (!Array.isArray(input.lotUids) || input.lotUids.length < 1 || input.lotUids.length > 100) throw new AuctionContractError(contract, 'lotUids must contain 1–100 values');
  const uniqueLotUids = new Set();
  input.lotUids.forEach((value, index) => {
    if (typeof value !== 'string') throw new AuctionContractError(contract, `lotUids[${index}] must be a string`);
    const lotUid = string(value, contract, `lotUids[${index}]`, { max: 255 });
    if (!publicAuctionImage.normalizePublicAuctionLotUid(lotUid)) throw new AuctionContractError(contract, `lotUids[${index}] is not storage-safe`);
    if (uniqueLotUids.has(lotUid)) throw new AuctionContractError(contract, 'lotUids must be unique');
    uniqueLotUids.add(lotUid);
  });
  if (input.limit != null) {
    if (typeof input.limit !== 'number') throw new AuctionContractError(contract, 'limit must be a number');
    number(input.limit, contract, 'limit', { integer: true, min: 1, max: 100 });
  }
  if (input.maxConcurrency != null) {
    if (typeof input.maxConcurrency !== 'number') throw new AuctionContractError(contract, 'maxConcurrency must be a number');
    number(input.maxConcurrency, contract, 'maxConcurrency', { integer: true, min: 1, max: 4 });
  }
  return input;
}
function validateThumbnailPublishResult(input) {
  const contract = 'thumbnailPublishResult'; object(input, contract);
  onlyFields(input, ['schemaVersion', 'requestId', 'correlationId', 'success', 'requested', 'processed', 'publishedCount', 'skippedCount', 'failedCount', 'published', 'skipped', 'failed'], contract);
  version(input, contract);
  if (typeof input.requestId !== 'string' || typeof input.correlationId !== 'string') {
    throw new AuctionContractError(contract, 'requestId and correlationId must be strings');
  }
  string(input.requestId, contract, 'requestId', { max: 100 }); string(input.correlationId, contract, 'correlationId', { max: 255 });
  if (input.success !== true) throw new AuctionContractError(contract, 'success must be true');
  ['requested', 'processed', 'publishedCount', 'skippedCount', 'failedCount'].forEach((field) => {
    if (typeof input[field] !== 'number') throw new AuctionContractError(contract, `${field} must be a number`);
    number(input[field], contract, field, { integer: true, min: 0 });
  });
  for (const field of ['published', 'skipped', 'failed']) {
    if (!Array.isArray(input[field])) throw new AuctionContractError(contract, `${field} must be an array`);
  }
  const outcomeLotUids = new Set();
  for (const [index, outcome] of input.published.entries()) {
    object(outcome, contract, `published[${index}]`);
    onlyFields(outcome, ['lotUid', 'status', 'srcPath', 'previousSrcPath', 'imageUrl', 'thumbUrl', 'verifiedAt', 'width', 'height', 'contentType', 'sizeBytes', 'hash', 'ordinal', 'reused'], contract, `published[${index}]`);
    if (typeof outcome.lotUid !== 'string' || !publicAuctionImage.normalizePublicAuctionLotUid(outcome.lotUid)) throw new AuctionContractError(contract, `published[${index}].lotUid must be storage-safe`);
    if (outcomeLotUids.has(outcome.lotUid)) throw new AuctionContractError(contract, `duplicate outcome for lotUid ${outcome.lotUid}`);
    outcomeLotUids.add(outcome.lotUid);
    if (outcome.status !== 'ok') throw new AuctionContractError(contract, `published[${index}].status must be ok`);
    const srcPath = publicAuctionImage.normalizePublicAuctionImagePath(outcome.srcPath);
    if (!srcPath || srcPath.split('/')[1] !== outcome.lotUid) throw new AuctionContractError(contract, `published[${index}].srcPath must match lotUid`);
    if (outcome.previousSrcPath != null) string(outcome.previousSrcPath, contract, `published[${index}].previousSrcPath`, { max: 2048 });
    const expectedUrl = publicAuctionImage.buildPublicAuctionImageUrl(srcPath);
    if (outcome.imageUrl !== expectedUrl) throw new AuctionContractError(contract, `published[${index}].imageUrl must exactly match srcPath`);
    if (outcome.thumbUrl !== expectedUrl) throw new AuctionContractError(contract, `published[${index}].thumbUrl must exactly match srcPath`);
    isoTimestamp(outcome.verifiedAt, contract, `published[${index}].verifiedAt`);
    for (const field of ['width', 'height', 'sizeBytes']) {
      if (outcome[field] != null) {
        if (typeof outcome[field] !== 'number') throw new AuctionContractError(contract, `published[${index}].${field} must be a number`);
        number(outcome[field], contract, `published[${index}].${field}`, { integer: true, min: 1 });
      }
    }
    if (outcome.contentType != null) enumeration(outcome.contentType, ['image/jpeg', 'image/webp', 'image/png', 'image/avif'], contract, `published[${index}].contentType`);
    if (outcome.hash != null && (typeof outcome.hash !== 'string' || !SHA256_PATTERN.test(outcome.hash))) throw new AuctionContractError(contract, `published[${index}].hash must be sha256`);
    if (outcome.ordinal != null) {
      if (typeof outcome.ordinal !== 'number') throw new AuctionContractError(contract, `published[${index}].ordinal must be a number or null`);
      number(outcome.ordinal, contract, `published[${index}].ordinal`, { integer: true, min: 0 });
    }
    if (outcome.reused != null && typeof outcome.reused !== 'boolean') throw new AuctionContractError(contract, `published[${index}].reused must be boolean`);
  }
  for (const field of ['skipped', 'failed']) {
    const expectedStatus = field === 'skipped' ? 'skipped' : 'failed';
    input[field].forEach((outcome, index) => {
      object(outcome, contract, `${field}[${index}]`);
      onlyFields(outcome, ['lotUid', 'status', 'reason'], contract, `${field}[${index}]`);
      if (typeof outcome.lotUid !== 'string' || !publicAuctionImage.normalizePublicAuctionLotUid(outcome.lotUid)) throw new AuctionContractError(contract, `${field}[${index}].lotUid must be storage-safe`);
      if (outcomeLotUids.has(outcome.lotUid)) throw new AuctionContractError(contract, `duplicate outcome for lotUid ${outcome.lotUid}`);
      outcomeLotUids.add(outcome.lotUid);
      if (outcome.status !== expectedStatus) throw new AuctionContractError(contract, `${field}[${index}].status must be ${expectedStatus}`);
      if (typeof outcome.reason !== 'string') throw new AuctionContractError(contract, `${field}[${index}].reason must be a string`);
      string(outcome.reason, contract, `${field}[${index}].reason`, { max: 500 });
    });
  }
  if (input.published.length !== input.publishedCount || input.skipped.length !== input.skippedCount || input.failed.length !== input.failedCount) {
    throw new AuctionContractError(contract, 'outcome counts do not match outcome arrays');
  }
  if (input.processed !== outcomeLotUids.size || input.requested < input.processed) {
    throw new AuctionContractError(contract, 'requested/processed counts do not match outcomes');
  }
  return input;
}
function validateComparableLot(input) {
  const contract = 'comparableLot'; object(input, contract);
  onlyFields(input, ['schemaVersion', 'lotUid', 'lotRef', 'title', 'description', 'houseName', 'saleType', 'auctionDate', 'priceRealised', 'currency', 'estimateMin', 'estimateMax', 'lotNumber', 'sourceUrl', 'rankingScore', 'assetStatus', 'assetVerifiedAt', 'imageUrl'], contract);
  if (!Object.prototype.hasOwnProperty.call(input, 'title')) throw new AuctionContractError(contract, 'title is required (nullable)');
  if (!Object.prototype.hasOwnProperty.call(input, 'assetStatus')) throw new AuctionContractError(contract, 'assetStatus is required');
  version(input, contract);
  if (typeof input.lotUid !== 'string' || !publicAuctionImage.normalizePublicAuctionLotUid(input.lotUid)) throw new AuctionContractError(contract, 'lotUid must be storage-safe');
  const lotUid = string(input.lotUid, contract, 'lotUid', { max: 255 });
  if (input.lotRef != null) string(input.lotRef, contract, 'lotRef', { max: 255 });
  if (input.title != null) string(input.title, contract, 'title', { max: 2000 });
  if (input.description != null) string(input.description, contract, 'description', { max: 20000 });
  if (input.houseName != null) string(input.houseName, contract, 'houseName', { max: 500 });
  if (input.saleType != null) string(input.saleType, contract, 'saleType', { max: 100 });
  if (input.priceRealised != null) number(input.priceRealised, contract, 'priceRealised', { min: 0 });
  if (input.currency != null && !/^[A-Z]{3}$/.test(string(input.currency, contract, 'currency', { max: 3 }))) throw new AuctionContractError(contract, 'currency must be an ISO 4217 code');
  if (input.auctionDate != null) isoTimestamp(input.auctionDate, contract, 'auctionDate');
  if (input.estimateMin != null) number(input.estimateMin, contract, 'estimateMin', { min: 0 });
  if (input.estimateMax != null) number(input.estimateMax, contract, 'estimateMax', { min: 0 });
  if (input.estimateMin != null && input.estimateMax != null && Number(input.estimateMin) > Number(input.estimateMax)) throw new AuctionContractError(contract, 'estimateMin must not exceed estimateMax');
  if (input.lotNumber != null) string(input.lotNumber, contract, 'lotNumber', { max: 255 });
  if (input.sourceUrl != null) string(input.sourceUrl, contract, 'sourceUrl', { max: 2048 });
  if (input.rankingScore != null) number(input.rankingScore, contract, 'rankingScore', { min: 0 });
  const assetStatus = enumeration(input.assetStatus, ['available', 'unavailable', 'unknown'], contract, 'assetStatus');
  if (input.assetVerifiedAt != null) isoTimestamp(input.assetVerifiedAt, contract, 'assetVerifiedAt');
  if (input.imageUrl != null && typeof input.imageUrl !== 'string') throw new AuctionContractError(contract, 'imageUrl must be a string');
  if (input.imageUrl != null) string(input.imageUrl, contract, 'imageUrl', { max: 2048 });
  if (assetStatus === 'available' && (!input.assetVerifiedAt || !input.imageUrl)) throw new AuctionContractError(contract, 'available asset requires assetVerifiedAt and imageUrl');
  if (assetStatus === 'available') {
    const canonicalUrl = publicAuctionImage.normalizePublicAuctionImageUrl(input.imageUrl);
    const canonicalPath = canonicalUrl
      ? publicAuctionImage.normalizePublicAuctionImagePath(decodeURIComponent(new URL(canonicalUrl).pathname.replace(/^\/+/, '')))
      : null;
    if (!canonicalUrl || input.imageUrl !== canonicalUrl || canonicalPath?.split('/')[1] !== lotUid) {
      throw new AuctionContractError(contract, 'available asset imageUrl must be canonical and match lotUid');
    }
  }
  if (assetStatus !== 'available' && (input.imageUrl != null || input.assetVerifiedAt != null)) throw new AuctionContractError(contract, 'non-available asset must not expose imageUrl or assetVerifiedAt');
  return input;
}
function validateAuctionSearchRequest(input) {
  const contract = 'auctionSearchRequest'; object(input, contract);
  onlyFields(input, ['schemaVersion', 'query', 'sort', 'limit', 'cursor', 'filters'], contract);
  version(input, contract);
  string(input.query, contract, 'query', { max: 500 });
  if (input.sort != null) enumeration(input.sort, ['relevance', 'date_desc', 'price_desc', 'price_asc'], contract, 'sort');
  if (input.limit != null) number(input.limit, contract, 'limit', { integer: true, min: 1, max: 200 });
  if (input.cursor != null) string(input.cursor, contract, 'cursor', { max: 2048 });
  if (input.filters != null) {
    const filters = object(input.filters, contract, 'filters');
    onlyFields(filters, ['minPrice', 'maxPrice', 'dateFrom', 'dateTo', 'categories', 'auctionHouses', 'keywords', 'artist', 'requireImages', 'requirePublicImages'], contract, 'filters');
    const minPrice = filters.minPrice == null ? null : number(filters.minPrice, contract, 'filters.minPrice', { min: 0 });
    const maxPrice = filters.maxPrice == null ? null : number(filters.maxPrice, contract, 'filters.maxPrice', { min: 0 });
    if (minPrice != null && maxPrice != null && minPrice > maxPrice) throw new AuctionContractError(contract, 'filters.minPrice must not exceed filters.maxPrice');
    const dateFrom = filters.dateFrom == null ? null : isoTimestamp(filters.dateFrom, contract, 'filters.dateFrom');
    const dateTo = filters.dateTo == null ? null : isoTimestamp(filters.dateTo, contract, 'filters.dateTo');
    if (dateFrom && dateTo && Date.parse(dateFrom) > Date.parse(dateTo)) throw new AuctionContractError(contract, 'filters.dateFrom must not exceed filters.dateTo');
    for (const field of ['categories', 'auctionHouses', 'keywords']) {
      if (filters[field] != null) stringArray(filters[field], contract, `filters.${field}`);
    }
    if (filters.artist != null) string(filters.artist, contract, 'filters.artist', { max: 200 });
    for (const field of ['requireImages', 'requirePublicImages']) {
      if (filters[field] != null && typeof filters[field] !== 'boolean') throw new AuctionContractError(contract, `filters.${field} must be boolean`);
    }
  }
  return input;
}
function validateAuctionSearchResponse(input) {
  const contract = 'auctionSearchResponse'; object(input, contract);
  onlyFields(input, ['schemaVersion', 'success', 'query', 'sort', 'ranking', 'lots', 'nextCursor', 'source'], contract);
  version(input, contract);
  if (input.success !== true) throw new AuctionContractError(contract, 'success must be true');
  string(input.query, contract, 'query', { max: 500 });
  enumeration(input.sort, ['relevance', 'date_desc', 'price_desc', 'price_asc'], contract, 'sort');
  string(input.ranking, contract, 'ranking', { max: 100 });
  if (!Array.isArray(input.lots) || input.lots.length > 200) throw new AuctionContractError(contract, 'lots must contain at most 200 values');
  input.lots.forEach(validateComparableLot);
  if (input.nextCursor != null) string(input.nextCursor, contract, 'nextCursor', { max: 2048 });
  if (input.source != null) string(input.source, contract, 'source', { max: 100 });
  return input;
}
const validators = Object.freeze({ pageArtifact: validatePageArtifact, validEmptyArtifact: validateValidEmptyArtifact, scrapeJobRequest: validateScrapeJobRequest, scrapeJobStatus: validateScrapeJobStatus, scrapeJobResult: validateScrapeJobResult, pageAudit: validatePageAudit, noveltyDecision: validateNoveltyDecision, ingestCommand: validateIngestCommand, ingestResult: validateIngestResult, thumbnailPublishRequest: validateThumbnailPublishRequest, thumbnailPublishResult: validateThumbnailPublishResult, comparableLot: validateComparableLot, auctionSearchRequest: validateAuctionSearchRequest, auctionSearchResponse: validateAuctionSearchResponse });
function validateContract(contract, input) { const validator = validators[contract]; if (!validator) throw new AuctionContractError(contract, 'unknown contract'); return validator(input); }
function isTerminalIngestCommandStatus(status) { return INGEST_COMMAND_TERMINAL_STATUSES.includes(String(status || '')); }

module.exports = { AuctionContractError, CONTRACT_VERSIONS, INGEST_COMMAND_STATUSES, INGEST_COMMAND_TERMINAL_STATUSES, SCRAPE_JOB_STATUSES, isTerminalIngestCommandStatus, validateAuctionSearchRequest, validateAuctionSearchResponse, validateComparableLot, validateContract, validateIngestCommand, validateIngestResult, validateNoveltyDecision, validatePageArtifact, validatePageAudit, validateScrapeJobRequest, validateScrapeJobResult, validateScrapeJobStatus, validateThumbnailPublishRequest, validateThumbnailPublishResult, validateValidEmptyArtifact, ...publicAuctionImage };
