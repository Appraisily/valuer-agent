import { describe, expect, it } from 'vitest';
import { buildLotImageAssetContract, deriveInvaluableLotUrl } from '../services/scraper-db.js';

function withPublicAssetsBase<T>(fn: () => T): T {
  const previousBase = process.env.PUBLIC_ASSETS_BASE_URL;
  process.env.PUBLIC_ASSETS_BASE_URL = 'https://assets.example.test';

  try {
    return fn();
  } finally {
    if (previousBase === undefined) delete process.env.PUBLIC_ASSETS_BASE_URL;
    else process.env.PUBLIC_ASSETS_BASE_URL = previousBase;
  }
}

describe('buildLotImageAssetContract', () => {
  it('returns null image fields for missing paths', () => {
    expect(buildLotImageAssetContract(null)).toMatchObject({
      imagePath: null,
      thumbUrl: null,
      imageUrl: null,
      originalUrl: null,
    });
  });

  it('normalizes auction lot image URLs into the public asset contract', () => {
    withPublicAssetsBase(() => {
      const relativePath = 'auction-lots/example/original/image.jpg';
      const result = buildLotImageAssetContract(`/${relativePath}`);
      expect(result.imagePath).toBe(relativePath);
      expect(result.imageUrl).toBe(`https://assets.example.test/${relativePath}`);
      expect(result.originalUrl).toBe(`https://assets.example.test/${relativePath}`);
    });
  });

  it('trusts canonical asset paths supplied by the Auction Data API', () => {
    withPublicAssetsBase(() => {
      const relativePath = 'auction-lots/example/thumb/image.jpg';
      const result = buildLotImageAssetContract(relativePath);
      expect(result.imagePath).toBe(relativePath);
      expect(result.thumbUrl).toBe(`https://assets.example.test/${relativePath}`);
    });
  });

  it('rejects canonical paths containing traversal segments', () => {
    expect(buildLotImageAssetContract('auction-lots/example/../private/image.jpg')).toMatchObject({
      imagePath: null,
      imageUrl: null,
    });
  });

  it('rejects external auction image URLs', () => {
    withPublicAssetsBase(() => {
      const result = buildLotImageAssetContract('https://auction.example.com/images/lot.jpg');
      expect(result).toMatchObject({
        imagePath: null,
        thumbUrl: null,
        imageUrl: null,
        originalUrl: null,
      });
    });
  });
});

describe('deriveInvaluableLotUrl', () => {
  it('returns direct source URLs when present', () => {
    expect(deriveInvaluableLotUrl({
      sourceUrl: 'https://example.test/source',
      title: 'Ignored',
      lotRef: 'ABC123',
      lotNumber: '7',
    })).toBe('https://example.test/source');
  });

  it('derives an Invaluable URL from title, lot number, and lotRef', () => {
    expect(deriveInvaluableLotUrl({
      title: '19th Century German School Oil Painting after Eduard von Grützner',
      lotRef: 'ABC123DEF0',
      lotNumber: '359',
    })).toBe('https://www.invaluable.com/auction-lot-19th-century-german-school-oil-painting-after-eduard-von-grutzner-359-c-abc123def0');
  });

  it('does not derive from title and numeric lot uid alone', () => {
    expect(deriveInvaluableLotUrl({
      title: '19th Century German School Oil Painting',
      lotRef: null,
      lotNumber: '359',
    })).toBeNull();
  });
});
