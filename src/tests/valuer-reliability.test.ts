import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuctionDataApiError, type ScraperDbLot } from '../services/scraper-db.js';
import { ValuerService } from '../services/valuer.js';

const lot: ScraperDbLot = {
  lotUid: 'lot-1', lotRef: null, title: 'Fixture lot', description: null,
  houseName: 'Fixture House', auctionDate: '2026-01-01T00:00:00.000Z',
  priceRealised: 100, currency: 'USD', currencySymbol: '$', estimateMin: null,
  estimateMax: null, lotNumber: null, saleType: null, sourceUrl: null, rankingScore: 3.5,
  imagePath: null, imageFileName: null, imageUrl: null, assetStatus: 'unknown',
  assetVerifiedAt: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AUCTION_DATA_API_CIRCUIT_FAILURES;
});

describe('Valuer request budgets', () => {
  it('retries transient failures inside the caller deadline', async () => {
    const searchLots = vi.fn()
      .mockRejectedValueOnce(new AuctionDataApiError('auction_data_api_503', { status: 503, transient: true }))
      .mockResolvedValueOnce([lot]);
    const service = new ValuerService({ scraperDb: { searchLots, close: async () => undefined } });
    const result = await service.batchSearch(
      { searches: [{ query: 'fixture' }], skipThumbPublish: true },
      { timeoutMs: 2_000, retry: { attempts: 2, baseDelayMs: 10 } },
    );
    expect(searchLots).toHaveBeenCalledTimes(2);
    expect(result.batch).toEqual({ total: 1, completed: 1, failed: 0 });
    expect(result.searches[0].attempts).toBe(2);
  });

  it('does not retry deterministic client failures or empty results', async () => {
    const permanent = vi.fn().mockRejectedValue(new AuctionDataApiError('invalid_search_request', { status: 400, transient: false }));
    const failedService = new ValuerService({ scraperDb: { searchLots: permanent, close: async () => undefined } });
    const failed = await failedService.batchSearch(
      { searches: [{ query: 'bad' }], skipThumbPublish: true },
      { timeoutMs: 2_000, retry: { attempts: 3, baseDelayMs: 10 } },
    );
    expect(permanent).toHaveBeenCalledTimes(1);
    expect(failed.searches[0].diagnostic).toMatchObject({ retryable: false, upstreamStatus: 400 });

    const empty = vi.fn().mockResolvedValue([]);
    const emptyService = new ValuerService({ scraperDb: { searchLots: empty, close: async () => undefined } });
    const result = await emptyService.batchSearch(
      { searches: [{ query: 'known empty' }], skipThumbPublish: true },
      { timeoutMs: 2_000, retry: { attempts: 3, baseDelayMs: 10 } },
    );
    expect(empty).toHaveBeenCalledTimes(1);
    expect(result.searches[0].result.success).toBe(true);
    expect(result.searches[0].result.data.totalResults).toBe(0);
  });

  it('reports partial batches and does not launch a retry beyond the deadline', async () => {
    const searchLots = vi.fn(async (params: { query: string }) => {
      if (params.query === 'ok') return [lot];
      throw new AuctionDataApiError('auction_data_api_timeout', { transient: true });
    });
    const service = new ValuerService({ scraperDb: { searchLots, close: async () => undefined } });
    const result = await service.batchSearch(
      { searches: [{ query: 'ok' }, { query: 'timeout' }], concurrency: 1, skipThumbPublish: true },
      { timeoutMs: 100, retry: { attempts: 3, baseDelayMs: 100 } },
    );
    expect(result.batch).toEqual({ total: 2, completed: 1, failed: 1 });
    expect(result.diagnostics.partial).toBe(true);
    expect(result.diagnostics.failures[0].error).toBe('deadline_exhausted');
    expect(searchLots).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit after repeated transient transport failures', async () => {
    process.env.AUCTION_DATA_API_CIRCUIT_FAILURES = '2';
    const searchLots = vi.fn().mockRejectedValue(new AuctionDataApiError('auction_data_api_503', { status: 503, transient: true }));
    const service = new ValuerService({ scraperDb: { searchLots, close: async () => undefined } });
    const result = await service.batchSearch(
      { searches: [{ query: 'one' }, { query: 'two' }, { query: 'three' }], concurrency: 1, skipThumbPublish: true },
      { timeoutMs: 2_000, retry: { attempts: 1 } },
    );
    expect(searchLots).toHaveBeenCalledTimes(2);
    expect(result.searches[2].error).toBe('auction_data_api_circuit_open');
  });
});
