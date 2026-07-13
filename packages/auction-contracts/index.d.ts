export type ContractName = 'pageArtifact' | 'validEmptyArtifact' | 'scrapeJobRequest' | 'scrapeJobStatus' | 'scrapeJobResult' | 'pageAudit' | 'noveltyDecision' | 'ingestCommand' | 'ingestResult' | 'thumbnailPublishRequest' | 'thumbnailPublishResult' | 'comparableLot';
export declare class AuctionContractError extends TypeError { contract: string; code: 'INVALID_CONTRACT' | 'UNSUPPORTED_SCHEMA_VERSION'; }
export declare const CONTRACT_VERSIONS: Readonly<Record<ContractName, 1>>;
export declare const INGEST_COMMAND_STATUSES: readonly string[];
export declare const INGEST_COMMAND_TERMINAL_STATUSES: readonly string[];
export declare const SCRAPE_JOB_STATUSES: readonly string[];
export interface PageArtifactMarkerV1 { schemaVersion: 1; pageNumber: number; outcome: 'results' | 'empty_valid' | 'empty_unverified' | 'invalid_schema'; lotCount: number; declaredTotal: number | null; recordedAt: string; }
export type PageArtifactV1 = Record<string, unknown> & { _appraisilyPageArtifact: PageArtifactMarkerV1 };
export type ValidEmptyArtifactV1 = PageArtifactV1 & { _appraisilyPageArtifact: PageArtifactMarkerV1 & { outcome: 'empty_valid'; lotCount: 0; declaredTotal: 0 } };
export interface ScrapeJobRequestV1 { schemaVersion: 1; jobId: string; idempotencyKey: string; correlationId: string; laneId: string; query: string; requestedAt: string; params?: Record<string, unknown>; }
export interface ScrapeJobStatusV1 { schemaVersion: 1; jobId: string; status: string; updatedAt: string; correlationId?: string; laneId?: string; progress?: Record<string, unknown>; }
export interface ScrapeJobResultV1 { schemaVersion: 1; jobId: string; status: 'completed' | 'failed' | 'cancelled'; finishedAt: string; artifactPath?: string; summary?: Record<string, unknown>; error?: string | null; }
export interface PageAuditV1 { schemaVersion: 1; keywordSlug: string; status: 'ok' | 'warn' | 'fail'; pages: number; auditedAt?: string; }
export interface NoveltyDecisionV1 { schemaVersion: 1; keyword: string; decision: 'promote' | 'images_only' | 'skip'; eligibleLotUids: string[]; }
export interface IngestCommandV1 { schemaVersion: 1; commandId: string; idempotencyKey: string; correlationId: string; requestedAt: string; caller: { identity: string; laneId: string }; subject: { type: 'keyword' | 'artist'; id: string }; artifact: { schemaVersion: 1; bucket: string; path: string }; audit: { status: 'ok' | 'warn'; reference: string }; novelty: { decision: 'promote' | 'images_only' | 'skip'; reference: string }; options?: { force?: boolean; concurrency?: number }; }
export interface IngestResultV1 { schemaVersion: 1; commandId: string; status: string; attempts: number; result?: Record<string, unknown> | null; errorReason?: string | null; finishedAt?: string | null; }
export interface ThumbnailPublishRequestV1 { schemaVersion: 1; requestId: string; correlationId: string; lotUids: string[]; maxConcurrency?: number; }
export interface ThumbnailPublishResultV1 { schemaVersion: 1; requestId: string; requested: number; processed: number; publishedCount: number; skippedCount: number; failedCount: number; }
export interface CanonicalComparableLotV1 { schemaVersion: 1; lotUid: string; title: string | null; description?: string | null; houseName?: string | null; auctionDate?: string | null; priceRealised?: number | null; currency?: string | null; estimateMin?: number | null; estimateMax?: number | null; sourceUrl?: string | null; thumbUrl?: string | null; }
export declare function validateContract<T = unknown>(contract: ContractName, input: T): T;
export declare function validatePageArtifact<T extends PageArtifactV1>(input: T): T;
export declare function validateValidEmptyArtifact<T extends ValidEmptyArtifactV1>(input: T): T;
export declare function validateScrapeJobRequest<T extends ScrapeJobRequestV1>(input: T): T;
export declare function validateScrapeJobStatus<T extends ScrapeJobStatusV1>(input: T): T;
export declare function validateScrapeJobResult<T extends ScrapeJobResultV1>(input: T): T;
export declare function validatePageAudit<T extends PageAuditV1>(input: T): T;
export declare function validateNoveltyDecision<T extends NoveltyDecisionV1>(input: T): T;
export declare function validateIngestCommand<T extends IngestCommandV1>(input: T): T;
export declare function validateIngestResult<T extends IngestResultV1>(input: T): T;
export declare function validateThumbnailPublishRequest<T extends ThumbnailPublishRequestV1>(input: T): T;
export declare function validateThumbnailPublishResult<T extends ThumbnailPublishResultV1>(input: T): T;
export declare function validateComparableLot<T extends CanonicalComparableLotV1>(input: T): T;
export declare function isTerminalIngestCommandStatus(status: unknown): boolean;

