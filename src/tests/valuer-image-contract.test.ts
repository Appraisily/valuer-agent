import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValuerService } from '../services/valuer.js';
import type { AuctionDataApiLot, AuctionDataApiSearchParams } from '../services/auction-data-api.js';

function baseLot(overrides: Partial<AuctionDataApiLot> = {}): AuctionDataApiLot {
  return {
    lotUid: 'lot-1',
    lotRef: null,
    title: 'Test lot',
    description: 'A test lot',
    houseName: 'Test House',
    auctionDate: '2026-01-01',
    priceRealised: 1200,
    currency: 'USD',
    currencySymbol: '$',
    estimateMin: null,
    estimateMax: null,
    lotNumber: '1',
    saleType: null,
    sourceUrl: 'https://example.test/lot/1',
    rankingScore: 4.5,
    imagePath: null,
    imageFileName: 'lot.jpg',
    imageUrl: null,
    assetStatus: 'unknown',
    assetVerifiedAt: null,
    ...overrides,
  };
}

function withPublicAssetsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const previousBase = process.env.PUBLIC_ASSETS_BASE_URL;
  const previousRoot = process.env.PUBLIC_STORAGE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valuer-assets-'));
  process.env.PUBLIC_ASSETS_BASE_URL = 'https://assets.example.test';
  process.env.PUBLIC_STORAGE_ROOT = root;

  return fn(root).finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousBase === undefined) delete process.env.PUBLIC_ASSETS_BASE_URL;
    else process.env.PUBLIC_ASSETS_BASE_URL = previousBase;
    if (previousRoot === undefined) delete process.env.PUBLIC_STORAGE_ROOT;
    else process.env.PUBLIC_STORAGE_ROOT = previousRoot;
  });
}

describe('ValuerService image contract', () => {
  it('sends and validates the strict thumbnail publish request identity', async () => {
    await withPublicAssetsRoot(async (root) => {
      const relativePath = 'auction-lots/lot-1/thumb/0123456789abcdef.jpg';
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'image');

      const previousFetch = globalThis.fetch;
      const previousKey = process.env.OPS_THUMB_API_KEY;
      const previousUrl = process.env.SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL;
      process.env.OPS_THUMB_API_KEY = 'test-thumb-key';
      process.env.SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL = 'http://scraper-ops-api:8080/api/lot-thumbs/publish';
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe(process.env.SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL);
        const request = JSON.parse(String(init?.body));
        const headers = init?.headers as Record<string, string>;
        expect(request).toMatchObject({
          schemaVersion: 1,
          lotUids: ['lot-1'],
          limit: 1,
          maxConcurrency: 1,
        });
        expect(headers['x-api-key']).toBe('test-thumb-key');
        expect(headers['x-request-id']).toBe(request.requestId);
        expect(headers['x-correlation-id']).toBe(request.correlationId);
        return new Response(JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          correlationId: request.correlationId,
          success: true,
          requested: 1,
          processed: 1,
          publishedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          published: [{
            lotUid: 'lot-1',
            status: 'ok',
            srcPath: relativePath,
            thumbUrl: `https://assets.appraisily.com/${relativePath}`,
            verifiedAt: '2026-08-01T00:00:00.000Z',
          }],
          skipped: [],
          failed: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      try {
        const service = new ValuerService({
          auctionDataApi: {
            searchLots: async (_params: AuctionDataApiSearchParams) => [baseLot()],
            close: async () => undefined,
          },
        });
        const result = await service.batchSearch({ searches: [{ query: 'test lot', limit: 1 }] });
        const lot = result.searches[0].result.data.lots[0];
        expect(lot.imageUrl).toBe(`https://assets.example.test/${relativePath}`);
        expect(lot.assetStatus).toBe('available');
        expect(lot.assetVerifiedAt).toBe('2026-08-01T00:00:00.000Z');
      } finally {
        globalThis.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.OPS_THUMB_API_KEY;
        else process.env.OPS_THUMB_API_KEY = previousKey;
        if (previousUrl === undefined) delete process.env.SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL;
        else process.env.SCRAPER_ORCHESTRATOR_THUMBS_PUBLISH_URL = previousUrl;
      }
    });
  });

  it('hydrates missing lot images through the bounded owned-asset publisher', async () => {
    await withPublicAssetsRoot(async (root) => {
      const relativePath = 'auction-lots/lot-1/thumb/0123456789abcdef.jpg';
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'image');

      const service = new ValuerService({
        auctionDataApi: {
          searchLots: async (_params: AuctionDataApiSearchParams) => [
            baseLot({ imagePath: 'legacy-art/images/lot-1.jpg' }),
          ],
          close: async () => undefined,
        },
        thumbPublisher: async (lotUids) => {
          expect(lotUids).toEqual(['lot-1']);
          return new Map([
            ['lot-1', {
              thumbUrl: `https://assets.appraisily.com/${relativePath}`,
              srcPath: relativePath,
              verifiedAt: '2026-08-01T00:00:00.000Z',
            }],
          ]);
        },
      });

      const result = await service.batchSearch({ searches: [{ query: 'test lot', limit: 1 }] });
      const lot = result.searches[0].result.data.lots[0];

      expect(lot.imageUrl).toBe(`https://assets.example.test/${relativePath}`);
      expect(lot.assetStatus).toBe('available');
      expect(lot.assetVerifiedAt).toBeTruthy();
    });
  });

  it('checks the bounded owned-asset publisher when legacy image hints are absent', async () => {
    await withPublicAssetsRoot(async (root) => {
      const relativePath = 'auction-lots/lot-1/thumb/image.jpg';
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'image');

      const service = new ValuerService({
        auctionDataApi: {
          searchLots: async (_params: AuctionDataApiSearchParams) => [
            baseLot({ imagePath: null, imageFileName: null, imageUrl: null, assetStatus: 'unknown' }),
          ],
          close: async () => undefined,
        },
        thumbPublisher: async (lotUids) => {
          expect(lotUids).toEqual(['lot-1']);
          return new Map([
            ['lot-1', {
              thumbUrl: `https://assets.appraisily.com/${relativePath}`,
              srcPath: relativePath,
              verifiedAt: '2026-08-01T00:00:00.000Z',
            }],
          ]);
        },
      });

      const result = await service.batchSearch({ searches: [{ query: 'test lot', limit: 1 }] });
      const lot = result.searches[0].result.data.lots[0];

      expect(lot.imageUrl).toBe(`https://assets.example.test/${relativePath}`);
      expect(lot.assetStatus).toBe('available');
      expect(lot.assetVerifiedAt).toBeTruthy();
    });
  });

  it('does not publish unverified fallback image URLs from the publisher response', async () => {
    await withPublicAssetsRoot(async () => {
      const service = new ValuerService({
        auctionDataApi: {
          searchLots: async (_params: AuctionDataApiSearchParams) => [
            baseLot({ imagePath: 'legacy-art/images/lot-1.jpg' }),
          ],
          close: async () => undefined,
        },
        thumbPublisher: async () => new Map([
          ['lot-1', {
            thumbUrl: 'https://assets.appraisily.com/auction-lots/lot-1/thumb/image.jpg',
            srcPath: 'legacy-art/images/lot-1.jpg',
            verifiedAt: '2026-08-01T00:00:00.000Z',
          }],
        ]),
      });

      const result = await service.batchSearch({ searches: [{ query: 'test lot', limit: 1 }] });
      const lot = result.searches[0].result.data.lots[0];

      expect(lot.imageUrl).toBeNull();
      expect(lot.assetStatus).toBe('unknown');
    });
  });

  it('emits the canonical source URL field for scraper DB lots', async () => {
    await withPublicAssetsRoot(async () => {
      const service = new ValuerService({
        auctionDataApi: {
          searchLots: async (_params: AuctionDataApiSearchParams) => [
            baseLot({
              lotUid: '130582130',
              lotRef: 'ABC123DEF0',
              title: '19th Century German School Oil Painting',
              lotNumber: '359',
              sourceUrl: 'https://www.invaluable.com/auction-lot-19th-century-german-school-oil-painting-359-c-abc123def0',
              imagePath: null,
            }),
          ],
          close: async () => undefined,
        },
      });

      const result = await service.batchSearch({ searches: [{ query: 'german school oil painting', limit: 1 }] });
      const lot = result.searches[0].result.data.lots[0];

      expect(lot.sourceUrl).toBe('https://www.invaluable.com/auction-lot-19th-century-german-school-oil-painting-359-c-abc123def0');
      expect(lot.lotRef).toBe('ABC123DEF0');
    });
  });

  it('preserves missing scraper currency instead of coercing it to USD', async () => {
    await withPublicAssetsRoot(async () => {
      const service = new ValuerService({
        auctionDataApi: {
          searchLots: async (_params: AuctionDataApiSearchParams) => [
            baseLot({ currency: null, currencySymbol: null }),
          ],
          close: async () => undefined,
        },
      });

      const result = await service.batchSearch({ searches: [{ query: 'unknown currency lot', limit: 1 }] });
      const lot = result.searches[0].result.data.lots[0];

      expect(lot.priceRealised).toBe(1200);
      expect(lot.currency).toBeNull();
    });
  });
});
