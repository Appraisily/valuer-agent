# Auction contracts

`@appraisily/auction-contracts` is the versioned boundary shared by Auction Acquisition and Auction Data Service. It also preserves fixtures for the `scrapper`, `scraper-orchestrator`, and `valuer-bridge` compatibility contracts. It ships JSON Schemas, CommonJS/ESM validators, TypeScript declarations, and compatibility fixtures.

Contract changes are additive within a major version. An incompatible producer change increments `schemaVersion`; consumers explicitly accept that version before deployment. Unsupported versions fail with `AuctionContractError.code === "UNSUPPORTED_SCHEMA_VERSION"`.

Auction search v1 uses the same request and comparable-lot response for public and
valuation callers. Requests contain `query`, `sort`, `limit`, opaque `cursor`, and
the documented price/date/category/house/keyword/artist/image filters. Results use
source-currency numeric values without conversion; unknown currencies are `null`.
`sourceUrl` is the source lot URL. `imageUrl` is non-null only when `assetStatus` is
`available` and `assetVerifiedAt` records a successful public-storage check.

Ranking is deterministic by relevance score, auction timestamp, then lot UID.
Relevance cursors bind all three values and the selected sort. Price cursors bind
price, timestamp, and lot UID; date cursors bind timestamp and lot UID. Limits are
500 query characters, 2,048 cursor characters, and 200 lots at the contract layer.
The public product narrows this to 20 results and 400 candidates with a four-second
execution deadline; valuation narrows it to 200 results and 1,000 candidates with
an eight-second database deadline. Valuer callers may impose a shorter absolute
batch deadline, which also bounds retries.

This package validates boundaries. It does not own scraping, persistence, ranking, or transport.
