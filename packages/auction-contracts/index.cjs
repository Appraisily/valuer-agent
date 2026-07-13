'use strict';

const CONTRACT_VERSIONS = Object.freeze({
  pageArtifact: 1, validEmptyArtifact: 1, scrapeJobRequest: 1, scrapeJobStatus: 1,
  scrapeJobResult: 1, pageAudit: 1, noveltyDecision: 1, ingestCommand: 1,
  ingestResult: 1, thumbnailPublishRequest: 1, thumbnailPublishResult: 1, comparableLot: 1,
});
const INGEST_COMMAND_TERMINAL_STATUSES = Object.freeze(['success', 'partial', 'permanent_failure', 'rejected_invalid_artifact']);
const INGEST_COMMAND_STATUSES = Object.freeze(['pending', 'running', 'retryable_failure', ...INGEST_COMMAND_TERMINAL_STATUSES]);
const SCRAPE_JOB_STATUSES = Object.freeze(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SUBJECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;

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
function number(value, contract, field, { integer = false, min = -Infinity, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || (integer && !Number.isInteger(normalized)) || normalized < min) throw new AuctionContractError(contract, `${field} is invalid`);
  return normalized;
}
function enumeration(value, allowed, contract, field) {
  const normalized = string(value, contract, field);
  if (!allowed.includes(normalized)) throw new AuctionContractError(contract, `${field} has unsupported value ${normalized}`);
  return normalized;
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
  const contract = 'thumbnailPublishRequest'; object(input, contract); version(input, contract);
  string(input.requestId, contract, 'requestId', { max: 100 }); string(input.correlationId, contract, 'correlationId', { max: 255 });
  if (!Array.isArray(input.lotUids) || input.lotUids.length < 1 || input.lotUids.length > 100) throw new AuctionContractError(contract, 'lotUids must contain 1–100 values');
  input.lotUids.forEach((value, index) => string(value, contract, `lotUids[${index}]`, { max: 255 })); return input;
}
function validateThumbnailPublishResult(input) {
  const contract = 'thumbnailPublishResult'; object(input, contract); version(input, contract); string(input.requestId, contract, 'requestId', { max: 100 });
  ['requested', 'processed', 'publishedCount', 'skippedCount', 'failedCount'].forEach((field) => number(input[field], contract, field, { integer: true, min: 0 })); return input;
}
function validateComparableLot(input) {
  const contract = 'comparableLot'; object(input, contract); version(input, contract); string(input.lotUid, contract, 'lotUid', { max: 255 });
  if (input.title != null) string(input.title, contract, 'title', { max: 2000 }); if (input.priceRealised != null) number(input.priceRealised, contract, 'priceRealised', { min: 0 });
  if (input.currency != null) string(input.currency, contract, 'currency', { max: 16 }); if (input.auctionDate != null) isoTimestamp(input.auctionDate, contract, 'auctionDate'); return input;
}
const validators = Object.freeze({ pageArtifact: validatePageArtifact, validEmptyArtifact: validateValidEmptyArtifact, scrapeJobRequest: validateScrapeJobRequest, scrapeJobStatus: validateScrapeJobStatus, scrapeJobResult: validateScrapeJobResult, pageAudit: validatePageAudit, noveltyDecision: validateNoveltyDecision, ingestCommand: validateIngestCommand, ingestResult: validateIngestResult, thumbnailPublishRequest: validateThumbnailPublishRequest, thumbnailPublishResult: validateThumbnailPublishResult, comparableLot: validateComparableLot });
function validateContract(contract, input) { const validator = validators[contract]; if (!validator) throw new AuctionContractError(contract, 'unknown contract'); return validator(input); }
function isTerminalIngestCommandStatus(status) { return INGEST_COMMAND_TERMINAL_STATUSES.includes(String(status || '')); }

module.exports = { AuctionContractError, CONTRACT_VERSIONS, INGEST_COMMAND_STATUSES, INGEST_COMMAND_TERMINAL_STATUSES, SCRAPE_JOB_STATUSES, isTerminalIngestCommandStatus, validateComparableLot, validateContract, validateIngestCommand, validateIngestResult, validateNoveltyDecision, validatePageArtifact, validatePageAudit, validateScrapeJobRequest, validateScrapeJobResult, validateScrapeJobStatus, validateThumbnailPublishRequest, validateThumbnailPublishResult, validateValidEmptyArtifact };

