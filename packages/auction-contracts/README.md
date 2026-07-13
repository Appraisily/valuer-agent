# Auction contracts

`@appraisily/auction-contracts` is the versioned boundary shared by Scrapper, Scraper Orchestrator, and Valuer Bridge. It ships JSON Schemas, CommonJS/ESM validators, TypeScript declarations, and compatibility fixtures.

Contract changes are additive within a major version. An incompatible producer change increments `schemaVersion`; consumers explicitly accept that version before deployment. Unsupported versions fail with `AuctionContractError.code === "UNSUPPORTED_SCHEMA_VERSION"`.

This package validates boundaries. It does not own scraping, persistence, ranking, or transport.

