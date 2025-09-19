# Appraisal SEO Surface Plan

## Goals
- Make eligible appraisal reports discoverable by search engines without breaking existing ID-based routing.
- Generate consistent, keyword-rich landing pages directly from appraisal JSON while keeping sensitive data concealed.
- Preserve customer trust by enforcing publication gates and rapid takedowns when an appraisal should not be indexed.

## Data Model Updates
- Add columns on the `appraisals` table: `slug`, `seo_status`, `public_indexable`, `seo_title`, `seo_description`, `seo_excerpt`, `seo_schema_json`, `seo_last_synced_at`, `seo_error`, `seo_source_version`, and optional `short_id` cache for routing.
- `seo_status` lifecycle: `draft` → `needs_review` → `published`; use `noindex` for suppressed records. `public_indexable` (boolean) is the hard gate for serving the SEO page.
- Track provenance with `seo_generator` (e.g. `programmatic`), `seo_editor_id` (nullable) for manual overrides, and timestamps for generation/review.

## URL & Routing Strategy
- Canonical route: `/appraisals/{slug}-{shortId}` where `shortId` is a stable suffix derived from the existing ID (e.g. last 6 chars or Base36 hash) to ensure uniqueness.
- Preserve legacy links by 301-redirecting `/appraisals/{appraisalId}` to the slugged path. Accept requests with stale/missing slugs and redirect to the current value.
- Slug template: `{city}-{state}-{property-type}-{appraised-value}` → transliterate to ASCII, lowercase, hyphenate, trim to ≤70 chars; append the shortId when collisions arise.

## Content Pipeline (Programmatic)
- Fetch the canonical appraisal JSON from GCS (signed URL or service account). Normalize into a DTO covering property summary, valuation metrics, comps, neighborhood insights, media, appraisal date, and reviewer info (respecting privacy rules).
- Build deterministic helper functions to derive copy: headline, H1, meta title (`"{Property Type} Appraisal in {City}, {State} | {Brand}"`), meta description, summary bullets, and OG text. Prefer templated phrasing with conditional clauses rather than freeform text.
- Render SEO artifacts using a templating layer (e.g. React server components, Handlebars, or markdown-to-HTML). Output: HTML section for the appraisal body, structured data (JSON-LD `Article` + `Product`), OpenGraph/Twitter metadata, and optional internal link slots.
- Sanitize and validate outputs: strip PII, ensure required fields are populated, enforce length limits, and compare generated hash against `seo_source_version` to detect drift.
- Persist artifacts and status back to the `appraisals` row; set `seo_status = needs_review`. Allow manual QA to promote to `published` (which flips `public_indexable` and queues cache invalidation).

## Rendering & Delivery
- Serve `/appraisals/{slug}-{shortId}` via SSR/SSG so crawlers receive full HTML. For Next.js, prefer ISR: generate static HTML from the stored SEO payload and revalidate when `seo_last_synced_at` changes.
- Include canonical `<link>` to the slugged URL, meta tags, structured data script, and OG/Twitter tags. Expose an inline JSON blob or API call for client-side enhancements if necessary.
- Provide fallbacks: if `public_indexable` is false or payload fetch fails, return 404 with `noindex` and avoid leaking partial content.
- Cache rendered pages at the CDN with short TTL; trigger revalidation when the appraisal JSON or SEO artifacts update.

## Sitemap & Internal Linking
- Maintain an appraisal-specific sitemap (`/sitemap-appraisals.xml`) that lists only `public_indexable` records. Chunk into ≤10k URLs per sitemap file and reference from the sitemap index.
- Regenerate the sitemap whenever new appraisals reach `published` or existing ones are revoked.
- Surface internal links from relevant blog posts, product pages, and geographic hubs to distribute authority to appraisal pages.

## Privacy & Compliance
- Enforce a publishing checklist: required fields present, no customer names or full street addresses (unless explicitly approved), review date within acceptable range.
- Log every publication change with user ID and reason. Provide a fast "revoke" action that marks the record `noindex`, purges caches, and drops the sitemap entry.
- Monitor rendered HTML for leaked identifiers or templating errors; alert on repeated `seo_error` occurrences per appraisal.

## Phased Implementation Steps
1. **Data Layer**: create migration for new columns, extend ORM models, update API contracts, and backfill `short_id` + placeholder `slug` for legacy records.
2. **Slug & Sync Jobs**: implement deterministic slug builder, background job to assign/regenerate slugs, and historical backfill runner with logging + dry-run mode.
3. **Content Generator**: build the JSON → DTO normalizer, templated copy helpers, validation pipeline, and persistence to the `appraisals` table.
4. **Rendering Layer**: update frontend/router to serve slugged URLs, integrate SSR/ISR, inject SEO metadata, and handle 301/404 flows.
5. **Publishing & Ops**: add admin tools for review/promote/revoke, create sitemap generator + scheduler, hook up cache invalidation, and wire monitoring/alerts.

## Validation & KPIs
- Pre-launch: automate unit tests for slug creation and templated copy, QA sample pages for SEO completeness, run Lighthouse/structured-data validators, and ensure privacy mask rules pass.
- Post-launch: monitor Search Console impressions/clicks, organic sessions landing on appraisal pages, crawl stats for sitemap uptake, and error rates from the content generator.
- Success means a steady increase in organic traffic to appraisal pages, improved engagement (CTR, time on page), and rapid turnaround when appraisals are updated or revoked.
