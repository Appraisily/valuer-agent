import { SimplifiedAuctionItem } from './types.js';

// Interface for the core calculated statistics
export interface CoreStatistics {
    count: number;
    average_price: number;
    median_price: number;
    price_min: number;
    price_max: number;
    standard_deviation: number;
    coefficient_of_variation: number;
    target_percentile_raw: number; // Raw percentile before formatting
    confidence_level: string;
    z_score: number;
}

// Interface defining the structure for additional metrics calculation input
interface PriceStatsInput {
    zScore: number;
    percentile: number;
    priceTrend: number;
    coefficientOfVariation: number;
}

// Interface defining the structure for additional metrics output
export interface AdditionalMetrics {
    historical_significance: number;
    investment_potential: number;
    provenance_strength: number;
}

export class StatisticalAnalysisService {

    /**
     * Calculates core statistical measures from a list of auction results.
     * @param auctionResults - Array of simplified auction items.
     * @param targetValue - The target value for percentile and confidence calculations.
     * @returns A CoreStatistics object or null if insufficient data.
     */
    calculateCoreStatistics(auctionResults: SimplifiedAuctionItem[], targetValue: number): CoreStatistics | null {
        console.log('Calculating core statistics...');

        const validResults = auctionResults.filter(
            result => result && typeof result.price === 'number' && !isNaN(result.price) && result.price > 0
        );

        if (validResults.length === 0) {
            console.log('No valid auction results for core statistics calculation.');
            return null;
        }

        // Use all valid results provided by the aggregator
        const resultSubset = validResults; 
        console.log(`Using ${resultSubset.length} valid auction results for core statistics`);

        const prices = resultSubset.map(result => result.price);
        const sortedPrices = [...prices].sort((a, b) => a - b);

        const count = prices.length;
        const sum = prices.reduce((acc, price) => acc + price, 0);
        const mean = sum / count;
        const min = sortedPrices[0];
        const max = sortedPrices[count - 1];

        // Median
        let median;
        if (count % 2 === 0) {
            const midIndex = count / 2;
            median = (sortedPrices[midIndex - 1] + sortedPrices[midIndex]) / 2;
        } else {
            median = sortedPrices[Math.floor(count / 2)];
        }

        // Standard Deviation
        const sumSquaredDiff = prices.reduce((acc, price) => acc + Math.pow(price - mean, 2), 0);
        const variance = sumSquaredDiff / count;
        const standardDeviation = variance > 0 ? Math.sqrt(variance) : 0; // Avoid NaN for variance 0

        // Coefficient of Variation
        const coefficientOfVariation = mean > 0 ? (standardDeviation / mean) * 100 : 0;

        // Target Value Percentile (Raw)
        const belowTarget = sortedPrices.filter(price => price <= targetValue).length;
        const targetPercentileRaw = count > 0 ? (belowTarget / count) * 100 : 50; // Default to 50 if no count

        // Confidence Level & Z-Score
        const zScore = standardDeviation > 0 ? Math.abs(targetValue - mean) / standardDeviation : 0;
        let confidenceLevel;
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
            average_price: Math.round(mean),
            median_price: Math.round(median),
            price_min: Math.round(min),
            price_max: Math.round(max),
            standard_deviation: Math.round(standardDeviation),
            coefficient_of_variation: Math.round(coefficientOfVariation * 100) / 100,
            target_percentile_raw: targetPercentileRaw,
            confidence_level: confidenceLevel,
            z_score: zScore, // Include raw z-score
        };
    }

     /**
     * Calculates additional qualitative metrics based on statistical inputs.
     * @param priceStats - Object containing zScore, percentile, priceTrend, and coefficientOfVariation.
     * @returns Object containing historical_significance, investment_potential, and provenance_strength scores.
     */
    calculateAdditionalMetrics(priceStats: PriceStatsInput): AdditionalMetrics {
        // Ensure inputs are numbers
        const zScore = typeof priceStats.zScore === 'number' && !isNaN(priceStats.zScore) ? priceStats.zScore : 0;
        const percentile = typeof priceStats.percentile === 'number' && !isNaN(priceStats.percentile) ? priceStats.percentile : 50;
        const priceTrend = typeof priceStats.priceTrend === 'number' && !isNaN(priceStats.priceTrend) ? priceStats.priceTrend : 0;
        const cov = typeof priceStats.coefficientOfVariation === 'number' && !isNaN(priceStats.coefficientOfVariation) ? priceStats.coefficientOfVariation : 50; // Default CoV if invalid

        // Historical Significance (higher for higher percentiles)
        // Scale percentile (0-100) to a range (e.g., 50-100)
        const historicalSignificance = Math.min(100, Math.max(50, Math.round(percentile * 0.5 + 50)));

        // Investment Potential (combines trend, rarity/dispersion, exclusivity/percentile)
        // Trend factor: Map trend percentage (-50% to +50%) to a score component (e.g., 0-60)
        const trendFactor = (1 + Math.min(0.5, Math.max(-0.5, priceTrend / 100))) * 30; // Max 60
        // Rarity factor: Lower CoV suggests less dispersion (rarer consistent value?), map to score (e.g., 0-30)
        const rarityFactor = Math.min(30, Math.max(0, 30 - cov / 3)); // Lower CoV = higher score
         // Exclusivity factor: Higher percentile = more exclusive, map to score (e.g., 0-10)
        const exclusivityFactor = Math.min(10, Math.max(0, percentile * 0.1)); 
        const investmentPotential = Math.min(100, Math.max(0, Math.round(trendFactor + rarityFactor + exclusivityFactor)));

        // Provenance Strength (higher for values closer to the mean, i.e., lower z-score)
        // Map Z-score (0 to ~3+) to a score component (e.g., high score for low Z, lower for high Z)
        const provenanceBase = 75; // Base score
        const zScoreImpact = Math.max(-25, Math.min(15, 15 - zScore * 10)); // Penalize high z-scores, reward low
        const provenanceStrength = Math.min(100, Math.max(50, Math.round(provenanceBase + zScoreImpact)));

        return {
            historical_significance: historicalSignificance,
            investment_potential: investmentPotential,
            provenance_strength: provenanceStrength
        };
    }

     /**
     * Formats a raw percentile number into an ordinal string (e.g., 50 -> "50th").
     * @param num - The raw percentile number.
     * @returns The formatted ordinal string.
     */
    getOrdinalSuffix(num: number): string {
        const roundedNum = Math.round(num);
        const j = roundedNum % 10;
        const k = roundedNum % 100;

        if (j === 1 && k !== 11) return roundedNum + "st";
        if (j === 2 && k !== 12) return roundedNum + "nd";
        if (j === 3 && k !== 13) return roundedNum + "rd";

        return roundedNum + "th";
    }
} 