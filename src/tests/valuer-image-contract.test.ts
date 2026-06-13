import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValuerService } from '../services/valuer.js';
import type { ScraperDbLot, ScraperDbSearchParams } from '../services/scraper-db.js';

function baseLot(overrides: Partial<ScraperDbLot> = {}): ScraperDbLot {
  return {
    lotUid: 'lot-1',
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
    imagePath: null,
    imageFileName: 'lot.jpg',
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
  it('hydrates missing lot images through the bounded owned-asset publisher', async () => {
    await withPublicAssetsRoot(async (root) => {
      const relativePath = 'auction-lots/scraper-db/art/thumb/lot-1.jpg';
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'image');

      const service = new ValuerService({
        scraperDb: {
          searchLots: async (_params: ScraperDbSearchParams) => [
            baseLot({ imagePath: 'legacy-art/images/lot-1.jpg' }),
          ],
          close: async () => undefined,
        },
        thumbPublisher: async (lotUids) => {
          expect(lotUids).toEqual(['lot-1']);
          return new Map([
            ['lot-1', { thumbUrl: 'https://auction.example.com/hotlink.jpg', srcPath: relativePath }],
          ]);
        },
      });

      const result = await service.batchSearch({ searches: [{ query: 'test lot', limit: 1 }] });
      const lot = result.searches[0].result.data.lots[0];

      expect(lot.thumbUrl).toBe(`https://assets.example.test/${relativePath}`);
      expect(lot.imageUrl).toBe(`https://assets.example.test/${relativePath}`);
      expect(lot.image).toBe(`https://assets.example.test/${relativePath}`);
      expect(lot.imagePath).toBe(relativePath);
    });
  });

  it('does not publish unverified fallback image URLs from the publisher response', async () => {
    await withPublicAssetsRoot(async () => {
      const service = new ValuerService({
        scraperDb: {
          searchLots: async (_params: ScraperDbSearchParams) => [
            baseLot({ imagePath: 'legacy-art/images/lot-1.jpg' }),
          ],
          close: async () => undefined,
        },
        thumbPublisher: async () => new Map([
          ['lot-1', { thumbUrl: 'https://auction.example.com/hotlink.jpg', srcPath: null }],
        ]),
      });

      const result = await service.batchSearch({ searches: [{ query: 'test lot', limit: 1 }] });
      const lot = result.searches[0].result.data.lots[0];

      expect(lot.thumbUrl).toBeNull();
      expect(lot.thumbnail).toBeNull();
      expect(lot.imageUrl).toBeNull();
      expect(lot.image).toBeNull();
      expect(lot.originalUrl).toBeNull();
    });
  });
});
