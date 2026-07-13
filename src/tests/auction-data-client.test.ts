import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScraperDbClient } from '../services/scraper-db.js';

describe('Auction Data API comparable client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the canonical data API and preserves ranked lot order', async () => {
    process.env.AUCTION_DATA_API_URL = 'http://auction-data.test';
    process.env.AUCTION_DATA_API_KEY = 'data-read-key';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      schemaVersion: 1,
      ranking: 'valuer-strict-anchor-v1',
      lots: [
        {
          schemaVersion: 1,
          lotUid: 'lot-a',
          lotRef: 'ref-a',
          title: 'Wedgwood jasperware vase',
          description: null,
          houseName: 'Test House',
          auctionDate: '2026-01-02T00:00:00.000Z',
          priceRealised: 1250,
          currency: 'USD',
          currencySymbol: '$',
          estimateMin: 900,
          estimateMax: 1400,
          lotNumber: '12',
          saleType: null,
          sourceUrl: 'https://www.invaluable.com/example',
          imagePath: null,
          imageFileName: null,
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const client = new ScraperDbClient();
    const lots = await client.searchLots({ query: 'Wedgwood jasperware vase', minPrice: 100, limit: 5 });

    expect(lots.map(lot => lot.lotUid)).toEqual(['lot-a']);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('http://auction-data.test/api/v1/comparables/search');
    expect((request?.headers as Record<string, string>)['x-api-key']).toBe('data-read-key');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      query: 'Wedgwood jasperware vase',
      minPrice: 100,
      limit: 5,
    });
  });
});
