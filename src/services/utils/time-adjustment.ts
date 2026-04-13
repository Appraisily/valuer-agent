import { SimplifiedAuctionItem } from '../types.js';
import { CoreStatistics } from '../statistical-analysis.service.js';

// Configuration for recency weight decay
export interface RecencyConfig {
  fullWeightWindowMonths: number; // Sales within this window get weight 1.0
  decayRate: number;              // λ in e^(-λ × yearsAgo) — annual decay rate after window
  minimumWeight: number;          // Floor weight for very old sales
  missingDateWeight: number;      // Weight for items without parseable dates
}

export const DEFAULT_RECENCY_CONFIG: RecencyConfig = {
  fullWeightWindowMonths: 24,
  decayRate: 0.10,
  minimumWeight: 0.30,
  missingDateWeight: 0.50,
};

export interface WeightedItem {
  item: SimplifiedAuctionItem;
  weight: number;
}

export interface TimeAdjustmentSummary {
  total_weighted: number;
  avg_weight: number;
  date_range: string;
}

/**
 * Compute a recency weight for a single sale based on how old it is.
 * Uses exponential decay after a full-weight window.
 */
export function computeRecencyWeight(
  saleDate: string | undefined,
  referenceDate: Date,
  config: RecencyConfig = DEFAULT_RECENCY_CONFIG,
): number {
  if (!saleDate || typeof saleDate !== 'string') {
    return config.missingDateWeight;
  }

  let parsed: Date;
  try {
    parsed = new Date(saleDate);
    if (isNaN(parsed.getTime())) {
      return config.missingDateWeight;
    }
  } catch {
    return config.missingDateWeight;
  }

  const yearsAgo = (referenceDate.getTime() - parsed.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  // Future dates or very recent: full weight
  if (yearsAgo <= 0) return 1.0;

  const windowYears = config.fullWeightWindowMonths / 12;

  // Within the full-weight window
  if (yearsAgo <= windowYears) return 1.0;

  // Apply exponential decay after the window
  const yearsBeyondWindow = yearsAgo - windowYears;
  const weight = Math.exp(-config.decayRate * yearsBeyondWindow);

  // Apply floor
  return Math.max(config.minimumWeight, weight);
}

/**
 * Apply recency weights to an array of auction items.
 */
export function applyRecencyWeights(
  items: SimplifiedAuctionItem[],
  referenceDate: Date = new Date(),
  config: RecencyConfig = DEFAULT_RECENCY_CONFIG,
): WeightedItem[] {
  return items
    .filter(item => item && typeof item.price === 'number' && !isNaN(item.price) && item.price > 0)
    .map(item => ({
      item,
      weight: computeRecencyWeight(item.date, referenceDate, config),
    }));
}

/**
 * Generate a summary of the time adjustment for transparency.
 */
export function summarizeTimeAdjustment(weightedItems: WeightedItem[]): TimeAdjustmentSummary {
  if (weightedItems.length === 0) {
    return { total_weighted: 0, avg_weight: 0, date_range: 'N/A' };
  }

  const totalWeight = weightedItems.reduce((sum, wi) => sum + wi.weight, 0);
  const avgWeight = totalWeight / weightedItems.length;

  const dates = weightedItems
    .map(wi => wi.item.date)
    .filter((d): d is string => !!d)
    .map(d => new Date(d).getFullYear())
    .filter(y => !isNaN(y));

  const dateRange = dates.length >= 2
    ? `${Math.min(...dates)}–${Math.max(...dates)}`
    : dates.length === 1
      ? `${dates[0]}`
      : 'N/A';

  return {
    total_weighted: weightedItems.length,
    avg_weight: Math.round(avgWeight * 100) / 100,
    date_range: dateRange,
  };
}

/**
 * Compute core statistics using weighted values.
 * Produces the same CoreStatistics shape as calculateCoreStatistics but with recency-weighted aggregation.
 */
export function computeWeightedStats(
  weightedItems: WeightedItem[],
  targetValue: number,
): CoreStatistics | null {
  if (weightedItems.length === 0) return null;

  const prices = weightedItems.map(wi => wi.item.price);
  const weights = weightedItems.map(wi => wi.weight);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  if (totalWeight <= 0) return null;

  // Weighted mean
  const weightedMean = weightedItems.reduce((sum, wi) => sum + wi.weight * wi.item.price, 0) / totalWeight;

  // Weighted median: sort by price, accumulate weights until we hit 50%
  const sorted = [...weightedItems].sort((a, b) => a.item.price - b.item.price);
  let cumulativeWeight = 0;
  let weightedMedian = sorted[0].item.price;
  const halfWeight = totalWeight / 2;
  for (const wi of sorted) {
    cumulativeWeight += wi.weight;
    if (cumulativeWeight >= halfWeight) {
      weightedMedian = wi.item.price;
      break;
    }
  }

  // Min/max (unweighted — these are observed bounds)
  const sortedPrices = [...prices].sort((a, b) => a - b);
  const min = sortedPrices[0];
  const max = sortedPrices[sortedPrices.length - 1];

  // Weighted standard deviation
  const sumWeightedSquaredDiff = weightedItems.reduce(
    (sum, wi) => sum + wi.weight * Math.pow(wi.item.price - weightedMean, 2),
    0,
  );
  const weightedVariance = sumWeightedSquaredDiff / totalWeight;
  const standardDeviation = weightedVariance > 0 ? Math.sqrt(weightedVariance) : 0;

  // Coefficient of variation
  const coefficientOfVariation = weightedMean > 0 ? (standardDeviation / weightedMean) * 100 : 0;

  // Target value percentile (weighted)
  const weightedBelowTarget = weightedItems
    .filter(wi => wi.item.price <= targetValue)
    .reduce((sum, wi) => sum + wi.weight, 0);
  const targetPercentileRaw = (weightedBelowTarget / totalWeight) * 100;

  // Z-score and confidence level
  const zScore = standardDeviation > 0 ? Math.abs(targetValue - weightedMean) / standardDeviation : 0;
  const count = weightedItems.length;
  let confidenceLevel: string;
  if (count < 3) {
    confidenceLevel = 'Low (Limited Data)';
  } else if (zScore <= 0.5) {
    confidenceLevel = 'Very High';
  } else if (zScore <= 1.0) {
    confidenceLevel = 'High';
  } else if (zScore <= 1.5) {
    confidenceLevel = 'Moderate';
  } else if (zScore <= 2.0) {
    confidenceLevel = 'Low';
  } else {
    confidenceLevel = 'Very Low';
  }

  return {
    count,
    average_price: Math.round(weightedMean),
    median_price: Math.round(weightedMedian),
    price_min: Math.round(min),
    price_max: Math.round(max),
    standard_deviation: Math.round(standardDeviation),
    coefficient_of_variation: Math.round(coefficientOfVariation * 100) / 100,
    target_percentile_raw: targetPercentileRaw,
    confidence_level: confidenceLevel,
    z_score: zScore,
  };
}
