'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('../index.cjs');

const fixtures = path.resolve(__dirname, '../fixtures');
const read = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

test('all v1 fixtures pass their contract validators', () => {
  contracts.validatePageArtifact(read('page-artifact-results-v1.json'));
  contracts.validateValidEmptyArtifact(read('page-artifact-empty-v1.json'));
  const job = read('scrape-job-v1.json');
  contracts.validateScrapeJobRequest(job.request);
  contracts.validateScrapeJobStatus(job.status);
  contracts.validateScrapeJobResult(job.result);
  contracts.validatePageAudit(read('page-audit-v1.json'));
  contracts.validateNoveltyDecision(read('novelty-decision-v1.json'));
  contracts.validateIngestCommand(read('ingest-command-v1.json'));
  contracts.validateIngestResult(read('ingest-result-v1.json'));
  const thumb = read('thumbnail-publish-v1.json');
  contracts.validateThumbnailPublishRequest(thumb.request);
  contracts.validateThumbnailPublishResult(thumb.result);
  contracts.validateComparableLot(read('comparable-lot-v1.json'));
  contracts.validateAuctionSearchRequest(read('auction-search-request-v1.json'));
  contracts.validateAuctionSearchResponse(read('auction-search-response-v1.json'));
});

test('unsupported contract versions fail explicitly', () => {
  const command = read('ingest-command-v1.json');
  assert.throws(
    () => contracts.validateIngestCommand({ ...command, schemaVersion: 2 }),
    (error) => error.code === 'UNSUPPORTED_SCHEMA_VERSION' && /supported=1/.test(error.message)
  );
});

test('empty artifacts require the explicit valid-empty marker', () => {
  const artifact = read('page-artifact-empty-v1.json');
  artifact._appraisilyPageArtifact.outcome = 'empty_unverified';
  assert.throws(() => contracts.validateValidEmptyArtifact(artifact), /explicit empty_valid marker/);
});

test('ingest references reject traversal', () => {
  const command = read('ingest-command-v1.json');
  command.artifact.path = '../customer-data';
  assert.throws(() => contracts.validateIngestCommand(command), /storage-relative path/);
});
