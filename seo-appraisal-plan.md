# Appraisal SEO Surface Plan

## Goals
- Make eligible appraisal reports discoverable by search engines without breaking existing ID-based routing.
- Improve click-through by presenting descriptive, keyword-rich metadata for each published appraisal.
- Preserve customer privacy by only exposing sanitized appraisal content that passes marketing review.

## URL & Routing Strategy
- Keep the canonical route in the shape `/appraisals/{slug}-{shortId}` where `shortId` is a shortened version of the existing appraisal ID (e.g. last 6 characters) to guarantee uniqueness.
- Maintain backwards compatibility by 301-redirecting `/appraisals/{appraisalId}` to the slugged path and accepting requests where the slug is stale or missing.
- Persist `slug` and `public_indexable` fields on the appraisal record; regenerate the slug when key descriptive fields change (property type, location, headline).
- Slug format guideline: `{city}-{state}-{property-type}-{appraised-value}` with transliteration to ASCII, lower-case, hyphen separation, and length cap (70 chars). Append the shortId if the textual slug already exists.

## Publication Workflow
- Extend the appraisal processing pipeline to enqueue a "slug assignment" job once an appraisal is approved for marketing. Use the job to sanitize source fields, detect duplicates, and persist the slug + `public_indexable = true`.
- Build a backfill script to assign slugs to historical appraisals flagged for SEO; run in batches and log skipped records.
- Add a quality gate that blocks `public_indexable` if required fields (e.g. property summary, city, state, valuation date, valuation amount) are missing or if the report is marked private.

## Rendering & Delivery
- Switch appraisal detail pages to SSR/SSG so crawlers receive HTML content. For Next.js, use `getStaticProps` + ISR or `getServerSideProps` depending on freshness requirements.
- Serialize critical appraisal content into the HTML payload (headline, summary bullets, comparable sale notes). Hide PII such as exact addresses if necessary.
- Include canonical `<link rel="canonical">` referencing the slugged URL and add OpenGraph/Twitter cards mirroring the meta title/description.
- Provide fallback content for unpublished/locked reports (return 404 + `noindex`).

## SEO Enhancements
- Construct page-specific metadata: `title` template like "{Property Type} Appraisal in {City}, {State} – {Brand}" and meta description summarizing valuation highlights.
- Emit JSON-LD `Article` or `Product` schema capturing appraisal headline, description, appraised value, location, valuation date, and publisher details. Mark the `mainEntityOfPage` with the canonical URL.
- Generate an XML sitemap section for appraisals, chunked (e.g. 10k URLs per file). Update nightly or after slug assignments; expose via `/sitemap-appraisals.xml` and reference from the sitemap index.
- Link to appraisal pages from relevant blog posts, category hubs, and navigation surfaces to distribute internal link equity.

## Privacy & Compliance
- Only set `public_indexable = true` after explicit approval. Mask customer-identifiable info (full address, owner names) unless marketing policy permits disclosure.
- Add monitoring to detect leakage of sensitive tokens/identifiers in the rendered HTML.
- Provide tooling to revoke public status quickly—toggling the flag should purge caches and issue a 410/`noindex` response.

## Phased Implementation Steps
1. **Data Layer**: add migration for `slug`, `public_indexable`, and optional `shortId` cache; update API schema + validation.
2. **Slug Service**: implement deterministic slug builder, uniqueness resolver, and background jobs/backfill scripts.
3. **Frontend Routing**: update router, server, and client to honor slugged URLs, redirects, and canonical tags; add SSR/SSG plumbing.
4. **SEO Artifacts**: inject meta tags, JSON-LD, `noindex` handling, and sharing cards.
5. **Sitemap & Monitoring**: build sitemap generator, schedule updates, integrate with Search Console, and add alerts for indexing errors.

## Validation & KPIs
- Pre-launch: run automated checks (Lighthouse SEO audit, structured data validator), manual QA on slug correctness, privacy spot checks.
- Post-launch: track impressions & clicks in Google Search Console, monitor organic traffic to appraisal pages, observe crawl stats for sitemap adoption, and log slug regeneration errors.
- Success target: uplift in organic sessions originating from appraisal pages and growth in assisted conversions attributed to these landing pages.
