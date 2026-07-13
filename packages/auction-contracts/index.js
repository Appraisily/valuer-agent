import contracts from './index.cjs';
export const { AuctionContractError, CONTRACT_VERSIONS, INGEST_COMMAND_STATUSES, INGEST_COMMAND_TERMINAL_STATUSES, SCRAPE_JOB_STATUSES, isTerminalIngestCommandStatus, validateComparableLot, validateContract, validateIngestCommand, validateIngestResult, validateNoveltyDecision, validatePageArtifact, validatePageAudit, validateScrapeJobRequest, validateScrapeJobResult, validateScrapeJobStatus, validateThumbnailPublishRequest, validateThumbnailPublishResult, validateValidEmptyArtifact } = contracts;
export default contracts;

