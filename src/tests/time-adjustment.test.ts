import { describe, it, expect } from 'vitest';
import {
  computeRecencyWeight,
  applyRecencyWeights,
  computeWeightedStats,
  summarizeTimeAdjustment,
  DEFAULT_RECENCY_CONFIG,
} from '../services/utils/time-adjustment.js';
import { SimplifiedAuctionItem } from '../services/types.js';

// Reference date for deterministic tests: 2025-06-01
const REF = new Date('2025-06-01');

function makeItem(price: number, date?: string): SimplifiedAuctionItem {
  return {
    title: `Test Item ${price}`,
    price,
    currency: 'USD',
    house: 'Test House',
    date: date ?? '',
  };
}

describe('computeRecencyWeight', () => {
  it('gives full weight to sales within the 24-month window', () => {
    // 1 month ago
    expect(computeRecencyWeight('2025-05-01', REF)).toBeCloseTo(1.0);
    // 23 months ago
    expect(computeRecencyWeight('2023-07-01', REF)).toBeCloseTo(1.0);
    // exactly 24 months ago
    expect(computeRecencyWeight('2023-06-01', REF)).toBeCloseTo(1.0);
  });

  it('applies exponential decay for sales older than the window', () => {
    // 36 months ago = 3 years old = 1 year beyond window
    // weight = e^(-0.1 * 1) ≈ 0.905
    const weight3yr = computeRecencyWeight('2022-06-01', REF);
    expect(weight3yr).toBeGreaterThan(0.85);
    expect(weight3yr).toBeLessThan(1.0);

    // 12 years old = 10 years beyond window
    // weight = e^(-0.1 * 10) ≈ 0.368
    const weight12yr = computeRecencyWeight('2013-06-01', REF);
    expect(weight12yr).toBeGreaterThan(0.30);
    expect(weight12yr).toBeLessThan(0.40);
  });

  it('respects the minimum weight floor for very old sales', () => {
    // 50 years old = 48 years beyond window
    // e^(-0.1 * 48) ≈ 0.008 → floor at 0.30
    const weight = computeRecencyWeight('1975-06-01', REF);
    expect(weight).toBe(DEFAULT_RECENCY_CONFIG.minimumWeight);
  });

  it('gives full weight to future dates', () => {
    expect(computeRecencyWeight('2026-01-01', REF)).toBeCloseTo(1.0);
  });

  it('returns missingDateWeight for undefined or invalid dates', () => {
    expect(computeRecencyWeight(undefined, REF)).toBe(DEFAULT_RECENCY_CONFIG.missingDateWeight);
    expect(computeRecencyWeight('', REF)).toBe(DEFAULT_RECENCY_CONFIG.missingDateWeight);
    expect(computeRecencyWeight('not-a-date', REF)).toBe(DEFAULT_RECENCY_CONFIG.missingDateWeight);
  });
});

describe('applyRecencyWeights', () => {
  it('filters out invalid items and assigns weights', () => {
    const items = [
      makeItem(1000, '2025-01-01'),  // recent → weight 1.0
      makeItem(2000, '2015-01-01'),  // 10 years old → decayed
      makeItem(0, '2024-01-01'),     // price=0 → filtered out
      makeItem(500, undefined),      // no date → missingDateWeight
    ];

    const result = applyRecencyWeights(items, REF);

    expect(result).toHaveLength(3);
    expect(result[0].weight).toBeCloseTo(1.0);  // recent
    expect(result[1].weight).toBeLessThan(1.0);  // 10 years old
    expect(result[1].weight).toBeGreaterThan(0.3); // above floor
    expect(result[2].weight).toBe(DEFAULT_RECENCY_CONFIG.missingDateWeight);
  });
});

describe('computeWeightedStats', () => {
  it('returns null for empty input', () => {
    expect(computeWeightedStats([], 1000)).toBeNull();
  });

  it('produces same result as unweighted when all weights are equal', () => {
    const items = [
      { item: makeItem(100, '2024-01-01'), weight: 1.0 },
      { item: makeItem(200, '2024-02-01'), weight: 1.0 },
      { item: makeItem(300, '2024-03-01'), weight: 1.0 },
    ];

    const stats = computeWeightedStats(items, 200)!;

    expect(stats.average_price).toBe(200);
    expect(stats.median_price).toBe(200);
    expect(stats.count).toBe(3);
  });

  it('shifts weighted mean toward higher-weighted (more recent) items', () => {
    // 3 items: recent expensive, old cheap, old expensive
    // With decay, the recent one should pull the mean up
    const weighted = [
      { item: makeItem(5000, '2024-01-01'), weight: 1.0 },   // recent, high price
      { item: makeItem(1000, '2010-01-01'), weight: 0.30 },   // old, low price (floored)
      { item: makeItem(3000, '2010-06-01'), weight: 0.30 },   // old, medium price (floored)
    ];

    const stats = computeWeightedStats(weighted, 3000)!;

    // Unweighted mean = (5000+1000+3000)/3 = 3000
    // Weighted mean should be much closer to 5000 since it has weight 1.0 vs 0.30 each
    // weighted mean = (1.0*5000 + 0.3*1000 + 0.3*3000) / (1.0+0.3+0.3)
    //               = (5000+300+900) / 1.6 = 6200/1.6 = 3875
    expect(stats.average_price).toBe(3875);
    expect(stats.average_price).toBeGreaterThan(3000); // higher than unweighted mean
  });

  it('computes weighted percentile correctly', () => {
    const weighted = [
      { item: makeItem(100, '2024-01-01'), weight: 1.0 },
      { item: makeItem(200, '2024-02-01'), weight: 1.0 },
      { item: makeItem(300, '2024-03-01'), weight: 0.3 },
      { item: makeItem(400, '2024-04-01'), weight: 0.3 },
    ];

    const stats = computeWeightedStats(weighted, 250)!;

    // Total weight = 2.6, half = 1.3
    // Cumulative: 100→1.0, 200→2.0 (passes 1.3) → median = 200
    expect(stats.median_price).toBe(200);
    expect(stats.count).toBe(4);
    expect(stats.price_min).toBe(100);
    expect(stats.price_max).toBe(400);
  });
});

describe('summarizeTimeAdjustment', () => {
  it('returns correct summary with date range', () => {
    const weighted = [
      { item: makeItem(100, '2024-01-01'), weight: 1.0 },
      { item: makeItem(200, '2015-06-01'), weight: 0.4 },
      { item: makeItem(300, '2005-01-01'), weight: 0.3 },
    ];

    const summary = summarizeTimeAdjustment(weighted);

    expect(summary.total_weighted).toBe(3);
    expect(summary.avg_weight).toBeCloseTo(0.57, 1);
    expect(summary.date_range).toBe('2005–2024');
  });

  it('handles empty input', () => {
    const summary = summarizeTimeAdjustment([]);
    expect(summary.total_weighted).toBe(0);
    expect(summary.date_range).toBe('N/A');
  });
});
