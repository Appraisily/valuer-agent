import { describe, expect, it } from 'vitest';

async function loadCurrencySummary() {
  process.env.AUCTION_DATA_API_KEY ||= 'test-data-api-key';
  process.env.AUCTION_DATA_API_URL ||= 'http://127.0.0.1:9';
  const module = await import('../server.js');
  return module.summarizeComparableCurrencies;
}

describe('currency comparability summary', () => {
  it('marks single-currency comparable prices as comparable', async () => {
    const summarizeComparableCurrencies = await loadCurrencySummary();
    const summary = summarizeComparableCurrencies([
      { title: 'Lot A', price: { amount: 100, currency: 'usd', symbol: '$' } },
      { title: 'Lot B', price: { amount: 125, currency: 'USD', symbol: '$' } },
    ]);

    expect(summary).toMatchObject({
      status: 'single',
      valuesComparable: true,
      currency: 'USD',
      currencies: ['USD'],
      pricedLots: 2,
      unknownCurrencyLots: 0,
    });
  });

  it('marks mixed currencies as not directly comparable', async () => {
    const summarizeComparableCurrencies = await loadCurrencySummary();
    const summary = summarizeComparableCurrencies([
      { title: 'Lot A', price: { amount: 100, currency: 'USD', symbol: '$' } },
      { title: 'Lot B', price: { amount: 125, currency: 'EUR', symbol: 'EUR' } },
    ]);

    expect(summary.status).toBe('mixed');
    expect(summary.valuesComparable).toBe(false);
    expect(summary.currency).toBeNull();
    expect(summary.currencies).toEqual(['EUR', 'USD']);
  });

  it('marks missing currencies as unknown instead of assuming USD', async () => {
    const summarizeComparableCurrencies = await loadCurrencySummary();
    const summary = summarizeComparableCurrencies([
      { title: 'Lot A', price: { amount: 100, currency: null, symbol: null } },
    ]);

    expect(summary).toMatchObject({
      status: 'unknown',
      valuesComparable: false,
      currency: null,
      currencies: [],
      pricedLots: 1,
      unknownCurrencyLots: 1,
    });
  });
});
