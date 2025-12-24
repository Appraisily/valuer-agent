import { SimplifiedAuctionItem, HistogramBucket, PriceHistoryPoint, FormattedAuctionItem } from './types.js';

const MIN_ITEMS_FOR_GOOD_QUALITY = 5;

export class MarketReportService {

    /**
     * Calculates the year-over-year price trend based on the provided auction data.
     * @param auctionResults - Array of simplified auction items (should be the consistent set used for stats).
     * @returns Formatted price trend percentage string (e.g., "+5.1%").
     */
    calculatePriceTrend(auctionResults: SimplifiedAuctionItem[]): string {
        const validResults = auctionResults.filter(
            result => result && typeof result.price === 'number' && !isNaN(result.price) && result.price > 0
        );

        if (validResults.length < 2) return '+0.0%'; // Not enough data for trend

        // Try date-based trend calculation first
        try {
            const datedResults = validResults.filter(result => {
                try {
                    // Check for valid date string and that it parses correctly
                    return Boolean(result.date && typeof result.date === 'string' && new Date(result.date).getTime());
                } catch { return false; }
            });

            if (datedResults.length >= 3) { // Require at least 3 dated points for a meaningful trend
                const sortedByDate = [...datedResults].sort((a, b) =>
                    new Date(a.date!).getTime() - new Date(b.date!).getTime()
                );

                const oldestResult = sortedByDate[0];
                const newestResult = sortedByDate[sortedByDate.length - 1];
                const oldestPrice = oldestResult.price;
                const newestPrice = newestResult.price;
                const oldestDate = new Date(oldestResult.date!);
                const newestDate = new Date(newestResult.date!);
                
                // Ensure prices are valid
                if (oldestPrice <= 0 || newestPrice <= 0) {
                    throw new Error("Invalid prices for trend calculation");
                }

                // Calculate time difference in years (minimum 1 year)
                const yearDiff = Math.max(1, newestDate.getFullYear() - oldestDate.getFullYear());

                // Calculate total percentage change
                const totalChangeRatio = newestPrice / oldestPrice;
                // Calculate annualized geometric growth rate
                const annualGrowthRate = Math.pow(totalChangeRatio, 1 / yearDiff) - 1;
                const annualChangePercent = annualGrowthRate * 100;

                console.log('Date-based Price Trend Calculation:', {
                    oldestDate: oldestDate.toISOString().split('T')[0],
                    newestDate: newestDate.toISOString().split('T')[0],
                    oldestPrice, newestPrice, yearDiff, annualChangePercent
                });

                // Handle NaN or Infinity cases
                if (isNaN(annualChangePercent) || !isFinite(annualChangePercent)) {
                     console.warn("Calculated annual change is NaN or Infinity, falling back.");
                     throw new Error("Invalid trend calculation result");
                }

                return annualChangePercent >= 0
                    ? `+${annualChangePercent.toFixed(1)}%`
                    : `${annualChangePercent.toFixed(1)}%`;
            }
        } catch (e) {
            console.warn('Error calculating date-based price trend, falling back:', e instanceof Error ? e.message : e);
        }

        // Fallback: Simple trend based on min/max over an assumed period (e.g., 5 years)
        const prices = validResults.map(r => r.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (min <= 0) return '+0.0%'; // Avoid division by zero

        const assumedYears = 5;
        const totalChange = ((max - min) / min);
        const simpleAnnualTrend = (totalChange / assumedYears) * 100;
         console.log('Fallback Price Trend Calculation:', { min, max, assumedYears, simpleAnnualTrend });

        // Handle NaN/Infinity for fallback
        if (isNaN(simpleAnnualTrend) || !isFinite(simpleAnnualTrend)) {            
            return '+0.0%';
        }

        return simpleAnnualTrend >= 0
            ? `+${simpleAnnualTrend.toFixed(1)}%`
            : `${simpleAnnualTrend.toFixed(1)}%`;
    }

    /**
     * Generates histogram data (buckets) from sorted prices.
     * @param sortedPrices - A sorted array of valid auction prices (from the consistent set).
     * @param targetValue - The target value to mark in the histogram.
     * @param bucketCount - The desired number of histogram buckets (default 5).
     * @returns Array of HistogramBucket objects.
     */
    createHistogramBuckets(sortedPrices: number[], targetValue: number, bucketCount: number = 5): HistogramBucket[] {
        if (sortedPrices.length === 0) {
            return this.createDefaultHistogram(targetValue, bucketCount);
        }

        const minPrice = sortedPrices[0];
        const maxPrice = sortedPrices[sortedPrices.length - 1];
        const actualBucketCount = Math.min(bucketCount, sortedPrices.length); // Cannot have more buckets than items
        
        // Handle edge case where minPrice equals maxPrice
        if (minPrice === maxPrice) {
            const centerBucket = this.createDefaultHistogram(targetValue, actualBucketCount)[Math.floor(actualBucketCount/2)];
            centerBucket.count = sortedPrices.length;
            centerBucket.height = 100;
            centerBucket.min = minPrice;
            centerBucket.max = maxPrice;
            return [centerBucket]; // Return a single bucket
        }

        const range = maxPrice - minPrice;
        const bucketSize = range / actualBucketCount;

        const histogram: HistogramBucket[] = [];
        for (let i = 0; i < actualBucketCount; i++) {
            const bucketMin = minPrice + (i * bucketSize);
            // Ensure the last bucket includes the max price exactly
            const bucketMax = (i === actualBucketCount - 1) ? maxPrice : minPrice + ((i + 1) * bucketSize);

            // Filter prices falling into this bucket
            const bucketPrices = sortedPrices.filter(price =>
                price >= bucketMin && (i === actualBucketCount - 1 ? price <= bucketMax : price < bucketMax)
            );

            const count = bucketPrices.length;
            const containsTarget = targetValue >= bucketMin &&
                                  (i === actualBucketCount - 1 ? targetValue <= bucketMax : targetValue < bucketMax);
            
            // Calculate relative height
            const height = count > 0 ? (count / sortedPrices.length) * 100 : 0;

            histogram.push({
                min: Math.round(bucketMin),
                max: Math.round(bucketMax),
                count: count,
                position: (i / actualBucketCount) * 100, // Start position of bucket
                height: height,
                contains_target: containsTarget
            });
        }
        return histogram;
    }
    
     /**
     * Creates a default histogram structure when no real data is available.
     * @param targetValue - The target value to center the default histogram around.
     * @param bucketCount - The number of buckets for the default histogram.
     * @returns Array of default HistogramBucket objects.
     */
    private createDefaultHistogram(targetValue: number, bucketCount: number): HistogramBucket[] {
        // Create a simple histogram structure around the target value
        const estimatedMin = targetValue > 0 ? targetValue * 0.5 : 0;
        const estimatedMax = targetValue > 0 ? targetValue * 1.5 : 100; // Handle targetValue=0
        const range = estimatedMax - estimatedMin;
        const bucketSize = range > 0 ? range / bucketCount : 10;

        return Array.from({ length: bucketCount }, (_, i) => {
            const bucketMin = estimatedMin + (i * bucketSize);
            const bucketMax = (i === bucketCount - 1) ? estimatedMax : estimatedMin + ((i + 1) * bucketSize);
            const containsTarget = targetValue >= bucketMin && targetValue < bucketMax;
            const isMiddleBucket = i === Math.floor(bucketCount / 2);

            return {
                min: Math.round(bucketMin),
                max: Math.round(bucketMax),
                count: isMiddleBucket ? 1 : 0, // Place a single count in the middle
                position: (i / bucketCount) * 100,
                height: isMiddleBucket ? 20 : 5, // Give middle bucket some height, others minimal
                contains_target: containsTarget
            };
        });
    }

    /**
     * Generates price history data (yearly averages and index) from the provided auction results.
     * @param auctionResults - Array of simplified auction items (the consistent set).
     * @param itemValue - The current target value (used for default history).
     * @param historyYears - The desired number of years for the history (default 6).
     * @returns Array of PriceHistoryPoint objects.
     */
    generatePriceHistory(auctionResults: SimplifiedAuctionItem[], itemValue: number, historyYears: number = 6): PriceHistoryPoint[] {
        console.log('Generating price history from auction data...');

        const datedResults = auctionResults.filter(result => {
            try {
                return Boolean(result.date && typeof result.date === 'string' && new Date(result.date).getTime());
            } catch { return false; }
        });

        // Need at least 2 different years with data for trend calculation
        const yearsInData = new Set(datedResults.map(r => new Date(r.date!).getFullYear()));
        if (datedResults.length < 3 || yearsInData.size < 2) {
            console.log('Insufficient dated auction data for price history, using default.');
            return this.createDefaultPriceHistory(itemValue, historyYears);
        }

        try {
            // Group results by year and calculate average price
            const resultsByYear = new Map<number, number[]>();
            datedResults.forEach(result => {
                const year = new Date(result.date!).getFullYear();
                if (!resultsByYear.has(year)) resultsByYear.set(year, []);
                resultsByYear.get(year)?.push(result.price);
            });

            const yearlyAverages: { year: number; avgPrice: number }[] = [];
            resultsByYear.forEach((prices, year) => {
                const sum = prices.reduce((acc, p) => acc + p, 0);
                yearlyAverages.push({ year, avgPrice: Math.round(sum / prices.length) });
            });

            // Sort by year
            yearlyAverages.sort((a, b) => a.year - b.year);

            // Initial price history from calculated averages
            let priceHistory: PriceHistoryPoint[] = yearlyAverages.map(data => ({
                year: data.year.toString(),
                price: data.avgPrice,
                index: undefined // Calculated later
            }));

            // Extrapolate/Project to fill historyYears
            priceHistory = this.fillPriceHistoryYears(priceHistory, historyYears);

            // Calculate market index (base 1000 for the first year in the final history)
            const basePrice = priceHistory[0]?.price;
            if (basePrice && basePrice > 0) {
                const baseIndex = 1000;
                priceHistory.forEach(point => {
                    point.index = Math.round((point.price / basePrice) * baseIndex);
                });
            } else {
                 // Handle zero base price - assign default index?
                 priceHistory.forEach((point, i) => point.index = 1000 + i*10); // Simple increasing index
            }

            return priceHistory;

        } catch (error) {
            console.error('Error generating price history:', error);
            return this.createDefaultPriceHistory(itemValue, historyYears);
        }
    }
    
    /**
     * Creates a default price history (e.g., 6 years) with a slight trend.
     * @param itemValue - The current item value to base the history on.
     * @param historyYears - The number of years for the default history.
     * @returns Array of default PriceHistoryPoint objects.
     */
    private createDefaultPriceHistory(itemValue: number, historyYears: number): PriceHistoryPoint[] {
        const currentYear = new Date().getFullYear();
        const startYear = currentYear - (historyYears - 1);
        const defaultAnnualGrowth = 0.03; // 3% default annual growth
        const baseIndex = 1000;
        // Estimate a starting price `historyYears` ago
        const estimatedStartPrice = Math.max(1, itemValue / Math.pow(1 + defaultAnnualGrowth, historyYears - 1)); 

        return Array.from({ length: historyYears }, (_, index) => {
            const year = startYear + index;
            const yearFactor = Math.pow(1 + defaultAnnualGrowth, index);
            const price = Math.round(estimatedStartPrice * yearFactor);
            const indexValue = Math.round(baseIndex * yearFactor);
            return { year: year.toString(), price, index: indexValue };
        });
    }

    /**
     * Ensures the price history has the exact number of required years by
     * projecting future values or extrapolating past values.
     */
    private fillPriceHistoryYears(history: PriceHistoryPoint[], requiredYears: number): PriceHistoryPoint[] {
        if (history.length === 0) return []; // Should be handled before calling this
        
        const currentYear = new Date().getFullYear();
        let finalHistory = [...history];

        // Calculate existing trend (geometric mean if possible)
        let annualGrowth = 0.03; // Default growth
        if (finalHistory.length >= 2) {
            const first = finalHistory[0];
            const last = finalHistory[finalHistory.length - 1];
            const yearSpan = parseInt(last.year) - parseInt(first.year);
            if (yearSpan > 0 && first.price > 0 && last.price > 0) {
                annualGrowth = Math.pow(last.price / first.price, 1 / yearSpan) - 1;
            }
        }
         // Clamp growth rate to reasonable bounds (-50% to +100%)
        annualGrowth = Math.max(-0.5, Math.min(1.0, annualGrowth));

        // Project future years if needed
        let latestYear = parseInt(finalHistory[finalHistory.length - 1].year);
        while (latestYear < currentYear && finalHistory.length < requiredYears * 2) { // Add future years up to current, limit total points added
            latestYear++;
            const prevPrice = finalHistory[finalHistory.length - 1].price;
            const projectedPrice = Math.max(1, Math.round(prevPrice * (1 + annualGrowth))); // Ensure price > 0
            finalHistory.push({ year: latestYear.toString(), price: projectedPrice, index: undefined });
        }

        // Limit to most recent years if too long
        if (finalHistory.length > requiredYears) {
            finalHistory = finalHistory.slice(-requiredYears);
        }

        // Extrapolate past years if too short
        while (finalHistory.length < requiredYears) {
            const earliestYear = parseInt(finalHistory[0].year);
            const yearToAdd = earliestYear - 1;
            const nextPrice = finalHistory[0].price;
             // Extrapolate backwards: price = nextPrice / (1 + growth)
            const extrapolatedPrice = Math.max(1, Math.round(nextPrice / (1 + annualGrowth))); 
            finalHistory.unshift({ year: yearToAdd.toString(), price: extrapolatedPrice, index: undefined });
        }

        return finalHistory;
    }

    /**
     * Formats comparable sales data, adding the current item and prioritizing items with higher quality scores.
     * @param comparableSales - Array of raw comparable sales (the consistent set, pre-limit).
     * @param targetValue - The value of the item being compared against.
     * @returns Formatted array of comparable sales including the target item, sorted by quality/relevance.
     */
    formatComparableSales(
        comparableSales: SimplifiedAuctionItem[],
        targetValue: number
    ): FormattedAuctionItem[] {
        // First, check if we have quality scores from o3-mini
        const hasQualityScores = comparableSales.some(item => 
            typeof (item as any).quality_score === 'number'
        );
        
        // Sort by quality score if available, otherwise by price proximity
        const sortedSales = [...comparableSales].sort((a, b) => {
            if (hasQualityScores) {
                // Higher quality score comes first (descending order)
                const qualityA = (a as any).quality_score || 0;
                const qualityB = (b as any).quality_score || 0;
                return qualityB - qualityA;
            } else {
                // Fallback to price proximity (ascending order)
                return Math.abs(a.price - targetValue) - Math.abs(b.price - targetValue);
            }
        });
        
        // Limit to top 10 results if we have quality scores
        const topSales = hasQualityScores 
            ? sortedSales.slice(0, 10) 
            : sortedSales;
        
        // Format the sales with diff percentage
        const formattedSales: FormattedAuctionItem[] = topSales.map(result => {
            const priceDiff = targetValue > 0 ? ((result.price - targetValue) / targetValue) * 100 : 0;
            const diffFormatted = priceDiff >= 0 ? `+${priceDiff.toFixed(1)}%` : `${priceDiff.toFixed(1)}%`;
            
            // Include quality score in the output if available
            const formatted: FormattedAuctionItem = {
                ...result,
                diff: diffFormatted,
                is_current: false
            };
            
            // If we have a quality score, include it in the output
            if (typeof (result as any).quality_score === 'number') {
                formatted.quality_score = (result as any).quality_score;
                formatted.relevanceScore = (result as any).quality_score; // Keep for backward compatibility
            }
            
            return formatted;
        });

        // Create and insert the current item marker
        const currentItem: FormattedAuctionItem = {
            title: 'Your Item',
            house: '-',
            date: 'Current',
            price: targetValue,
            currency: formattedSales[0]?.currency || 'USD',
            description: undefined,
            diff: '-',
            is_current: true,
            relevanceScore: undefined
        };

        // If sorting by quality score, add the current item at the beginning
        if (hasQualityScores) {
            formattedSales.unshift(currentItem);
        } else {
            // Otherwise insert near items with similar prices
            let insertIndex = formattedSales.findIndex(sale => sale.price >= targetValue);
            if (insertIndex === -1) insertIndex = formattedSales.length; // Insert at end if all are lower
            formattedSales.splice(insertIndex, 0, currentItem);
        }
        
        // If we sorted by quality score, log the scores
        if (hasQualityScores) {
            console.log('Comparable sales sorted by AI quality score:');
            formattedSales.forEach((sale, index) => {
                if (!sale.is_current) {
                    console.log(`${index}. Score: ${sale.relevanceScore || 'N/A'}, Title: "${sale.title.substring(0, 50)}..."`);
                }
            });
        }

        return formattedSales;
    }

    /**
     * Determines data quality based on finding a minimum number of relevant items and their quality scores.
     * @param foundCount - Number of auction items found and used for analysis.
     * @param _targetCount - Original target count (now less relevant for quality).
     * @param auctionResults - Optional array of auction results with quality scores.
     * @returns Data quality indicator string.
     */
    determineDataQuality(
        foundCount: number, 
        _targetCount: number,
        auctionResults?: SimplifiedAuctionItem[]
    ): string {
        // If no items found, return poor quality
        if (foundCount === 0) return 'Poor - No comparable market data found';
        
        // Check if we have AI quality scores
        const itemsWithQualityScores = auctionResults?.filter(item => 
            typeof (item as any).quality_score === 'number'
        );
        
        if (itemsWithQualityScores && itemsWithQualityScores.length > 0) {
            // Calculate average quality score
            const totalQuality = itemsWithQualityScores.reduce((sum, item) => 
                sum + ((item as any).quality_score || 0), 0
            );
            const avgQuality = totalQuality / itemsWithQualityScores.length;
            
            console.log(`Average AI quality score: ${avgQuality.toFixed(1)} (from ${itemsWithQualityScores.length} items)`);
            
            // Determine quality based on both count and average score
            if (avgQuality >= 80 && foundCount >= 5) {
                return 'Excellent - High-quality relevant market data found';
            }
            
            if (avgQuality >= 70) {
                return foundCount >= 10 
                    ? 'Very Good - Substantial high-relevance market data found'
                    : 'Good - Quality relevant market data found';
            }
            
            if (avgQuality >= 50) {
                return foundCount >= 7
                    ? 'Good - Substantial relevant market data found'
                    : 'Moderate - Sufficient relevant market data found';
            }
            
            if (avgQuality >= 30) {
                return 'Fair - Moderate relevance market data found';
            }
            
            return foundCount < MIN_ITEMS_FOR_GOOD_QUALITY
                ? `Limited - Only ${foundCount} marginally relevant items found`
                : 'Limited - Marginally relevant market data found';
        }
        
        // Fallback to count-based quality assessment if no quality scores
        if (foundCount < MIN_ITEMS_FOR_GOOD_QUALITY) 
            return `Limited - Only ${foundCount} relevant item(s) found`;
        if (foundCount < 15) 
            return 'Moderate - Sufficient relevant market data found';
        if (foundCount < 50) 
            return 'Good - Substantial relevant market data found';
        return 'Excellent - Comprehensive relevant market data found';
    }
} 
