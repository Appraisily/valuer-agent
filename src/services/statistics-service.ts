import { 
  SimplifiedAuctionItem, 
  EnhancedStatistics, 
  HistogramBucket,
  PriceHistoryPoint
} from './types.js';
import { MarketDataService } from './market-data.js';
import { ValuerService } from './valuer.js';
import OpenAI from 'openai';

export class StatisticsService {
  private marketData: MarketDataService;
  
  constructor(private openai: OpenAI, valuer: ValuerService) {
    this.marketData = new MarketDataService(valuer);
  }
  
  /**
   * Extracts optimal search keywords for finding similar items
   * @param text Description of the item
   * @returns Array of search terms
   */
  private async extractKeywords(text: string): Promise<string[]> {
    console.log('Extracting optimized keywords for statistics:', text.substring(0, 100) + '...');
    
    try {
      // Use simpler prompt for statistics search
      const prompt = `
Extract specific search keywords for auction databases to find comparable items for:
"${text}"

Return a JSON array of search terms, from most specific to most general.
Include 5-10 terms for comprehensive market data collection.

Example response format:
["exact match", "variant 1", "broader term", "category"]`;
      
      const completion = await this.openai.chat.completions.create({
        model: "o3-mini",
        messages: [
          {
            role: "system",
            content: "You are an expert in auction terminology and item categorization."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      });
      
      const content = completion.choices[0]?.message?.content;
      if (!content) return [text];
      
      try {
        const keywords = JSON.parse(content);
        console.log('Extracted search keywords:', keywords.join(', '));
        return Array.isArray(keywords) ? keywords : [text];
      } catch (parseError) {
        console.warn('Failed to parse keywords JSON:', parseError);
        // Try to extract array-like content if JSON parsing fails
        const matches = content.match(/\[(.*)\]/s);
        if (matches && matches[1]) {
          const terms = matches[1]
            .split(',')
            .map(t => t.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, ''))
            .filter(t => t.length > 0);
          
          console.log('Extracted keywords from text:', terms.join(', '));
          return terms.length > 0 ? terms : [text];
        }
        return [text];
      }
    } catch (error) {
      console.error('Error extracting keywords:', error);
      return [text];
    }
  }
  
  /**
   * Gather comprehensive auction data for statistical analysis
   * @param text Description of the item
   * @param value Target value for the item
   * @returns Array of simplified auction items for analysis
   */
  private async gatherAuctionData(text: string, value: number): Promise<SimplifiedAuctionItem[]> {
    console.log('Gathering comprehensive auction data for statistics');
    
    // Extract optimal search keywords
    const searchTerms = await this.extractKeywords(text);
    
    // Search for market data using all terms, with a lower relevance threshold to gather more data
    const allResults = await this.marketData.searchMarketData(
      searchTerms, 
      value,           // Target value for reference
      false,           // Not for justification
      0.3              // Lower relevance threshold to gather more data
    );
    
    console.log('Market data search results:');
    allResults.forEach(result => {
      console.log(`- "${result.query}": ${result.data.length} items (relevance: ${result.relevance})`);
    });
    
    // Combine all results into a single array
    const allItems: SimplifiedAuctionItem[] = [];
    const seenTitles = new Set<string>();
    
    // Process results in order of relevance: very high, high, medium, broad
    const relevanceOrder = ['very high', 'high', 'medium', 'broad'];
    
    for (const relevanceLevel of relevanceOrder) {
      const relevantResults = allResults.filter(r => r.relevance === relevanceLevel);
      
      for (const result of relevantResults) {
        for (const item of result.data) {
          // Create a unique key for each item to avoid duplicates
          const itemKey = `${item.title}|${item.house}|${item.date}|${item.price}`;
          
          if (!seenTitles.has(itemKey)) {
            allItems.push(item);
            seenTitles.add(itemKey);
          }
        }
      }
    }
    
    console.log(`Total unique auction items gathered: ${allItems.length}`);
    return allItems;
  }
  
  /**
   * Calculate comprehensive statistics from auction results
   * @param auctionResults Array of auction items
   * @param targetValue Target value for comparison
   * @returns Enhanced statistics object
   */
  private calculateEnhancedStatistics(
    auctionResults: SimplifiedAuctionItem[], 
    targetValue: number
  ): EnhancedStatistics {
    console.log('Calculating enhanced statistics');
    
    // Filter out results with invalid prices
    const validResults = auctionResults.filter(
      result => result.price && !isNaN(result.price) && result.price > 0
    );
    
    if (validResults.length === 0) {
      console.log('No valid auction results for statistics calculation');
      // Return default statistics with empty price history and default scores
      return {
        count: 0,
        average_price: 0,
        median_price: 0,
        price_min: 0,
        price_max: 0,
        standard_deviation: 0,
        coefficient_of_variation: 0,
        percentile: '50th',
        confidence_level: 'Low',
        price_trend_percentage: '+0.0%',
        histogram: this.createDefaultHistogram(targetValue),
        comparable_sales: [],
        value: targetValue,
        target_marker_position: 50,
        // New fields for enhanced visualization
        price_history: this.createDefaultPriceHistory(targetValue),
        historical_significance: 75, // Default values
        investment_potential: 68,
        provenance_strength: 72
      };
    }
    
    // Ensure we're not using more than 100 results
    const maxResults = 100;
    const resultSubset = validResults.length > maxResults 
      ? validResults.slice(0, maxResults) 
      : validResults;
    
    console.log(`Using ${resultSubset.length} out of ${validResults.length} valid auction results for statistics`);
    
    // Extract prices for calculations
    const prices = resultSubset.map(result => result.price);
    
    // Sort prices for various calculations
    const sortedPrices = [...prices].sort((a, b) => a - b);
    
    // Basic statistics
    const count = prices.length;
    const sum = prices.reduce((acc, price) => acc + price, 0);
    const mean = sum / count;
    const min = sortedPrices[0];
    const max = sortedPrices[count - 1];
    
    // Median calculation
    let median;
    if (count % 2 === 0) {
      // Even number of items
      const midIndex = count / 2;
      median = (sortedPrices[midIndex - 1] + sortedPrices[midIndex]) / 2;
    } else {
      // Odd number of items
      median = sortedPrices[Math.floor(count / 2)];
    }
    
    // Standard deviation calculation
    const sumSquaredDiff = prices.reduce((acc, price) => {
      const diff = price - mean;
      return acc + (diff * diff);
    }, 0);
    const variance = sumSquaredDiff / count;
    const standardDeviation = Math.sqrt(variance);
    
    // Coefficient of variation (standardized measure of dispersion)
    const coefficientOfVariation = (standardDeviation / mean) * 100;
    
    // Calculate target value percentile
    const belowTarget = sortedPrices.filter(price => price <= targetValue).length;
    const targetPercentile = (belowTarget / count) * 100;
    
    // Determine confidence level based on proximity to mean and data spread
    let confidenceLevel;
    const zScore = Math.abs(targetValue - mean) / standardDeviation;
    
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
    
    // Create histogram data (5 buckets)
    const histogram = this.createHistogramBuckets(sortedPrices, targetValue);
    
    // Calculate target marker position for the histogram (percentage from left)
    const range = max - min;
    const targetMarkerPosition = range > 0 ? ((targetValue - min) / range) * 100 : 50;
    
    // Sort results by relevance to target value
    const sortedResults = [...resultSubset].sort((a, b) => {
      const diffA = Math.abs(a.price - targetValue);
      const diffB = Math.abs(b.price - targetValue);
      return diffA - diffB;
    });
    
    // Format comparable sales with percentage difference
    const formattedSales = sortedResults.map(result => {
      // Calculate percentage difference from target value
      const priceDiff = ((result.price - targetValue) / targetValue) * 100;
      const diffFormatted = priceDiff > 0 ? `+${priceDiff.toFixed(1)}%` : `${priceDiff.toFixed(1)}%`;
      
      return {
        title: result.title || 'Similar Item',
        house: result.house || 'Unknown',
        date: result.date || 'Unknown',
        price: result.price,
        currency: result.currency || 'USD',
        diff: diffFormatted
      };
    });
    
    // Add current item to sales comparison (as the second item)
    const currentItem: SimplifiedAuctionItem = {
      title: 'Your Item',
      house: '-',
      date: 'Current',
      price: targetValue,
      currency: 'USD',
      diff: '-',
      is_current: true
    };
    
    // Insert current item after the first most relevant item
    if (formattedSales.length > 0) {
      formattedSales.splice(1, 0, currentItem);
    } else {
      formattedSales.push(currentItem);
    }
    
    // Format percentile as ordinal number (1st, 2nd, 3rd, etc.)
    const percentile = this.getOrdinalSuffix(Math.round(targetPercentile));
    
    // Calculate year-over-year price trend
    const priceTrend = this.calculatePriceTrend(resultSubset, targetValue);
    
    // Generate price history data from auction results with dates
    const priceHistory = this.generatePriceHistory(resultSubset, targetValue);
    
    // Calculate additional metrics
    const priceStats = {
      zScore,
      percentile: targetPercentile,
      priceTrend: parseFloat(priceTrend.replace(/[^-0-9.]/g, '')),
      coefficientOfVariation
    };
    
    const additionalMetrics = this.calculateAdditionalMetrics(priceStats);
    
    // Create the enhanced statistics object
    return {
      count,
      average_price: Math.round(mean),
      median_price: Math.round(median),
      price_min: Math.round(min),
      price_max: Math.round(max),
      standard_deviation: Math.round(standardDeviation),
      coefficient_of_variation: Math.round(coefficientOfVariation * 100) / 100,
      percentile,
      confidence_level: confidenceLevel,
      price_trend_percentage: priceTrend,
      histogram,
      comparable_sales: formattedSales,
      value: targetValue,
      target_marker_position: targetMarkerPosition,
      total_count: validResults.length > maxResults ? validResults.length : undefined,
      
      // New fields for enhanced visualization
      price_history: priceHistory,
      historical_significance: additionalMetrics.historical_significance,
      investment_potential: additionalMetrics.investment_potential,
      provenance_strength: additionalMetrics.provenance_strength
    };
  }
  
  /**
   * Create histogram buckets for visualization
   * @param sortedPrices Sorted array of prices
   * @param targetValue Target value for comparison
   * @returns Array of histogram buckets
   */
  private createHistogramBuckets(sortedPrices: number[], targetValue: number): HistogramBucket[] {
    if (sortedPrices.length === 0) {
      return this.createDefaultHistogram(targetValue);
    }
    
    const min = sortedPrices[0];
    const max = sortedPrices[sortedPrices.length - 1];
    const bucketCount = Math.min(5, sortedPrices.length);
    const bucketSize = (max - min) / bucketCount;
    
    const histogram = Array(bucketCount).fill(null).map((_, i) => {
      const bucketMin = min + (i * bucketSize);
      const bucketMax = i === bucketCount - 1 ? max : min + ((i + 1) * bucketSize);
      
      const bucketPrices = sortedPrices.filter(price => 
        price >= bucketMin && (i === bucketCount - 1 ? price <= bucketMax : price < bucketMax)
      );
      
      const containsTarget = targetValue >= bucketMin && 
                          (i === bucketCount - 1 ? targetValue <= bucketMax : targetValue < bucketMax);
      
      return {
        min: bucketMin,
        max: bucketMax,
        count: bucketPrices.length,
        position: (i / bucketCount) * 100,
        height: bucketPrices.length > 0 ? (bucketPrices.length / sortedPrices.length) * 100 : 0,
        contains_target: containsTarget
      };
    });
    
    return histogram;
  }
  
  /**
   * Create default histogram when no data is available
   * @param targetValue Target value for comparison
   * @returns Default histogram buckets
   */
  private createDefaultHistogram(targetValue: number): HistogramBucket[] {
    // Create simple histogram around the target value
    const min = targetValue * 0.5;
    const max = targetValue * 1.5;
    const bucketSize = (max - min) / 5;
    
    return Array(5).fill(null).map((_, i) => {
      const bucketMin = min + (i * bucketSize);
      const bucketMax = i === 4 ? max : min + ((i + 1) * bucketSize);
      const containsTarget = targetValue >= bucketMin && targetValue < bucketMax;
      
      return {
        min: bucketMin,
        max: bucketMax,
        count: i === 2 ? 1 : 0, // Put a single count in the middle bucket
        position: i * 20, // 0, 20, 40, 60, 80
        height: i === 2 ? 100 : 0, // 100% height for middle bucket
        contains_target: containsTarget
      };
    });
  }
  
  /**
   * Create default price history data when insufficient data is available
   * @param targetValue Target value for comparison
   * @returns Default price history data
   */
  private createDefaultPriceHistory(targetValue: number): PriceHistoryPoint[] {
    // Create a default 6-year price history with slight rising trend
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 5;
    const defaultTrend = 0.05; // 5% annual growth rate
    
    return Array(6).fill(null).map((_, index) => {
      // Calculate year
      const year = (startYear + index).toString();
      
      // Calculate price for this year (starting from approximately 80% of current value)
      const yearFactor = Math.pow(1 + defaultTrend, index);
      const baseValue = targetValue * 0.8;
      const price = Math.round(baseValue * yearFactor);
      
      // Create index based on price (normalized to 1000 for the first year)
      const baseIndex = 1000;
      const index = Math.round(baseIndex * yearFactor);
      
      return { year, price, index };
    });
  }
  
  /**
   * Calculate additional item metrics based on statistical data
   * @param priceStats Statistical data about the item
   * @returns Object containing the three additional metrics
   */
  private calculateAdditionalMetrics(
    priceStats: {
      zScore: number; 
      percentile: number;
      priceTrend: number;
      coefficientOfVariation: number;
    }
  ): {
    historical_significance: number;
    investment_potential: number;
    provenance_strength: number;
  } {
    // Calculate historical significance (higher for items at higher percentiles)
    const historicalSignificance = Math.min(100, Math.max(50, Math.round(priceStats.percentile * 0.9 + 20)));
    
    // Calculate investment potential (higher for positive price trends and rare items)
    const trendFactor = (1 + Math.min(0.5, Math.max(-0.5, priceStats.priceTrend / 100))) * 30;
    const rarityFactor = Math.min(30, Math.max(0, 30 - priceStats.coefficientOfVariation / 2));
    const exclusivityFactor = Math.min(40, Math.max(0, priceStats.percentile * 0.4));
    const investmentPotential = Math.min(100, Math.max(0, Math.round(trendFactor + rarityFactor + exclusivityFactor)));
    
    // Calculate provenance strength (higher for items with values close to the mean)
    const provenanceBase = 65;
    const zScoreImpact = Math.max(-20, Math.min(15, 15 - priceStats.zScore * 10));
    const provenance = Math.min(100, Math.max(0, Math.round(provenanceBase + zScoreImpact)));
    
    return {
      historical_significance: historicalSignificance,
      investment_potential: investmentPotential,
      provenance_strength: provenance
    };
  }
  
  /**
   * Calculate price trend based on auction data
   * @param auctionResults Auction result items
   * @param targetValue Target value for comparison
   * @returns Formatted price trend percentage
   */
  private calculatePriceTrend(
    auctionResults: SimplifiedAuctionItem[], 
    targetValue: number
  ): string {
    // Try to use date information if available
    try {
      // Filter results with valid dates
      const datedResults = auctionResults.filter(result => {
        try {
          return Boolean(result.date && new Date(result.date).getTime());
        } catch (e) {
          return false;
        }
      });
      
      if (datedResults.length >= 3) {
        // Sort by date (oldest to newest)
        const sortedByDate = [...datedResults].sort((a, b) => {
          return new Date(a.date).getTime() - new Date(b.date).getTime();
        });
        
        // Get oldest and newest prices
        const oldestPrice = sortedByDate[0].price;
        const newestPrice = sortedByDate[sortedByDate.length - 1].price;
        
        // Calculate time difference in years
        const oldestDate = new Date(sortedByDate[0].date);
        const newestDate = new Date(sortedByDate[sortedByDate.length - 1].date);
        const yearDiff = Math.max(
          1,
          (newestDate.getFullYear() - oldestDate.getFullYear()) || 1
        );
        
        // Calculate annual percentage change
        const totalChange = (newestPrice - oldestPrice) / oldestPrice;
        const annualChange = totalChange / yearDiff * 100;
        
        console.log('Price trend calculation:', {
          oldestDate: oldestDate.toISOString().split('T')[0],
          newestDate: newestDate.toISOString().split('T')[0],
          oldestPrice,
          newestPrice,
          yearDiff,
          totalChange: totalChange * 100,
          annualChange
        });
        
        return annualChange >= 0 
          ? `+${annualChange.toFixed(1)}%` 
          : `${annualChange.toFixed(1)}%`;
      }
    } catch (e) {
      console.warn('Error calculating date-based price trend:', e);
    }
    
    // Fallback to simple calculation if date information is insufficient
    const prices = auctionResults.map(result => result.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    
    // Assume price trend based on min/max over 5 years
    const simpleTrend = ((max - min) / min) * 100 / 5;
    
    return simpleTrend >= 0 
      ? `+${simpleTrend.toFixed(1)}%` 
      : `${simpleTrend.toFixed(1)}%`;
  }
  
  /**
   * Format a number with ordinal suffix (1st, 2nd, 3rd, etc.)
   * @param num Number to format
   * @returns Number with ordinal suffix
   */
  private getOrdinalSuffix(num: number): string {
    const j = num % 10;
    const k = num % 100;
    
    if (j === 1 && k !== 11) return num + "st";
    if (j === 2 && k !== 12) return num + "nd";
    if (j === 3 && k !== 13) return num + "rd";
    
    return num + "th";
  }
  
  /**
   * Generate price history data from auction results
   * @param auctionResults Array of auction results with dates
   * @param targetValue Target value for the current item
   * @returns Array of price history points by year
   */
  private generatePriceHistory(
    auctionResults: SimplifiedAuctionItem[],
    targetValue: number
  ): PriceHistoryPoint[] {
    console.log('Generating price history from auction data');
    
    // Filter results with valid dates
    const datedResults = auctionResults.filter(result => {
      try {
        return Boolean(result.date && new Date(result.date).getTime());
      } catch (e) {
        return false;
      }
    });
    
    if (datedResults.length < 3) {
      console.log('Insufficient auction data with dates for price history, using default');
      return this.createDefaultPriceHistory(targetValue);
    }
    
    try {
      // Group auction results by year
      const resultsByYear = new Map<string, number[]>();
      
      datedResults.forEach(result => {
        try {
          const date = new Date(result.date);
          const year = date.getFullYear().toString();
          if (!resultsByYear.has(year)) {
            resultsByYear.set(year, []);
          }
          resultsByYear.get(year)?.push(result.price);
        } catch (e) {
          console.warn('Error processing date in price history:', e);
        }
      });
      
      if (resultsByYear.size < 2) {
        console.log('Not enough years in data for price history, using default');
        return this.createDefaultPriceHistory(targetValue);
      }
      
      // Calculate average price for each year
      const yearlyData: { year: string; prices: number[] }[] = [];
      resultsByYear.forEach((prices, year) => {
        yearlyData.push({ year, prices });
      });
      
      // Sort by year (ascending)
      yearlyData.sort((a, b) => parseInt(a.year) - parseInt(b.year));
      
      // Calculate average price for each year
      const priceHistory: PriceHistoryPoint[] = yearlyData.map(yearData => {
        const sum = yearData.prices.reduce((acc, price) => acc + price, 0);
        const averagePrice = Math.round(sum / yearData.prices.length);
        return {
          year: yearData.year,
          price: averagePrice,
          index: undefined // Initialize with undefined, will be set later
        };
      });
      
      // If we don't have at least the past few years, generate a more complete history
      const currentYear = new Date().getFullYear();
      // Calculate min/max years from the data (earliestYear not used directly)
      const years = priceHistory.map(item => parseInt(item.year));
      const latestYear = Math.max(...years);
      
      // If we're missing recent years, add them with projected values
      if (latestYear < currentYear) {
        // Calculate trend from existing data
        const firstPrice = priceHistory[0].price;
        const lastPrice = priceHistory[priceHistory.length - 1].price;
        const yearSpan = parseInt(priceHistory[priceHistory.length - 1].year) - parseInt(priceHistory[0].year);
        const annualGrowth = yearSpan > 0 ? Math.pow(lastPrice / firstPrice, 1 / yearSpan) - 1 : 0.05;
        
        // Add missing years with projected growth
        for (let year = latestYear + 1; year <= currentYear; year++) {
          const prevYearPrice = priceHistory[priceHistory.length - 1].price;
          const projectedPrice = Math.round(prevYearPrice * (1 + annualGrowth));
          priceHistory.push({
            year: year.toString(),
            price: projectedPrice,
            index: undefined
          });
        }
      }
      
      // Add market index numbers (starting at 1000 for the first year)
      const baseIndex = 1000;
      const basePrice = priceHistory[0].price;
      
      priceHistory.forEach(point => {
        const indexRatio = point.price / basePrice;
        point.index = Math.round(baseIndex * indexRatio);
      });
      
      // Ensure we have exactly 6 years (limit or fill as needed)
      if (priceHistory.length > 6) {
        // Keep most recent 6 years
        return priceHistory.slice(-6);
      } else if (priceHistory.length < 6) {
        // Fill with extrapolated years at the beginning
        const missingYears = 6 - priceHistory.length;
        const earliestExistingYear = parseInt(priceHistory[0].year);
        const extrapolated: PriceHistoryPoint[] = [];
        
        for (let i = missingYears; i > 0; i--) {
          const yearToAdd = (earliestExistingYear - i).toString();
          // Calculate growth factor from existing price data
          const firstPrice = priceHistory[0].price;
          const lastPrice = priceHistory[priceHistory.length - 1].price;
          const yearSpan = parseInt(priceHistory[priceHistory.length - 1].year) - parseInt(priceHistory[0].year);
          const annualGrowth = yearSpan > 0 ? Math.pow(firstPrice / lastPrice, 1 / yearSpan) : 0.95;
          const growthFactor = annualGrowth;
          const extrapolatedPrice = Math.round(priceHistory[0].price * Math.pow(growthFactor, i));
          const pointIndex = Math.round((priceHistory[0].index || 1000) * Math.pow(growthFactor, i));
          
          extrapolated.push({
            year: yearToAdd,
            price: extrapolatedPrice,
            index: pointIndex
          });
        }
        
        return [...extrapolated, ...priceHistory];
      }
      
      return priceHistory;
    } catch (error) {
      console.error('Error generating price history:', error);
      return this.createDefaultPriceHistory(targetValue);
    }
  }
  
  /**
   * Generate enhanced statistics for an item
   * @param text Description of the item
   * @param value The target value for comparison
   * @returns Enhanced statistics response
   */
  async generateStatistics(text: string, value: number): Promise<EnhancedStatistics> {
    console.log(`Generating enhanced statistics for "${text}" with value ${value}`);
    
    // Gather comprehensive auction data
    const auctionData = await this.gatherAuctionData(text, value);
    
    // Calculate enhanced statistics
    const statistics = this.calculateEnhancedStatistics(auctionData, value);
    
    return statistics;
  }
}