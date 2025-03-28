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
   * @returns Array of search terms from most specific to most general
   */
  private async extractKeywords(text: string): Promise<string[]> {
    console.log('Extracting optimized keywords for statistics:', text.substring(0, 100) + '...');
    
    try {
      // Enhanced prompt for more comprehensive search query generation
      const prompt = `
Generate multiple levels of search queries for finding comparable auction items for:
"${text}"

Create a JSON array of search queries at different specificity levels:
1. Very specific queries (5-6 words) that exactly match the item description
2. Specific queries (3-4 words) focusing on key identifying features
3. Moderate queries (2-3 words) capturing the item category and main characteristic
4. Broad queries (1-2 words) for the general category

The goal is to ensure sufficient auction data (up to 100 items) can be found even for rare items.
Order the array from most specific to most general.
Include 10-15 queries for comprehensive market data collection.

Example response format for "Antique Meissen Porcelain Tea Set with Floral Design, circa 1880":
[
  "Antique Meissen Porcelain Tea Set Floral 1880",
  "Meissen Porcelain Tea Set Floral",
  "Meissen Porcelain Tea Set",
  "Antique Meissen Porcelain 1880",
  "Meissen Porcelain Floral",
  "Antique Tea Set 1880",
  "Meissen Porcelain",
  "Antique Tea Set", 
  "Porcelain Tea Set",
  "Meissen Tea",
  "Antique Porcelain",
  "Tea Set",
  "Porcelain",
  "Meissen"
]`;
      
      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o",  // Use more capable model for better query generation
        messages: [
          {
            role: "system",
            content: "You are an expert in auction terminology, art, antiques, and collectibles categorization. Generate optimal search queries for finding comparable auction items."
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
        // Extract the JSON array from the response content
        const jsonMatch = content.match(/\[\s*".*"\s*\]/s);
        const jsonContent = jsonMatch ? jsonMatch[0] : content;
        
        const keywords = JSON.parse(jsonContent);
        
        // Log the structured queries by specificity level
        console.log('Extracted search queries by specificity:');
        const verySpecific = keywords.filter(k => k.split(' ').length >= 5);
        const specific = keywords.filter(k => k.split(' ').length >= 3 && k.split(' ').length < 5);
        const moderate = keywords.filter(k => k.split(' ').length === 2);
        const broad = keywords.filter(k => k.split(' ').length === 1);
        
        console.log(`- Very specific (${verySpecific.length}): ${verySpecific.join(', ')}`);
        console.log(`- Specific (${specific.length}): ${specific.join(', ')}`);
        console.log(`- Moderate (${moderate.length}): ${moderate.join(', ')}`);
        console.log(`- Broad (${broad.length}): ${broad.join(', ')}`);
        
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
        
        // Final fallback - use the original text plus some basic variants
        const fallbackKeywords = [
          text,
          // Extract the first 3-4 words as a more focused search
          text.split(' ').slice(0, 4).join(' '),
          // Extract first 2 words as a broader search
          text.split(' ').slice(0, 2).join(' '),
          // Extract the single most important word (usually the object type)
          text.split(' ')[text.split(' ').length > 1 ? 1 : 0]
        ];
        
        console.log('Using fallback keywords:', fallbackKeywords.join(', '));
        return fallbackKeywords;
      }
    } catch (error) {
      console.error('Error extracting keywords:', error);
      return [text];
    }
  }
  
  /**
   * Gather comprehensive auction data for statistical analysis using a progressive search strategy
   * @param text Description of the item
   * @param value Target value for the item
   * @param targetCount Target number of auction items to gather (default: 100)
   * @returns Array of simplified auction items for analysis
   */
  private async gatherAuctionData(
    text: string, 
    value: number, 
    targetCount: number = 100
  ): Promise<SimplifiedAuctionItem[]> {
    console.log(`Gathering comprehensive auction data for statistics (target: ${targetCount} items)`);
    
    // Extract optimal search keywords with multiple specificity levels
    const searchTerms = await this.extractKeywords(text);
    
    // Group search terms by specificity level for progressive searching
    const queryGroups = this.groupQueriesBySpecificity(searchTerms);
    
    // Initialize results array and tracking sets
    const allItems: SimplifiedAuctionItem[] = [];
    const seenTitles = new Set<string>();
    let totalResultsFound = 0;
    
    console.log('Starting progressive search strategy');
    
    // Progressive search through specificity levels
    for (const [level, queries] of Object.entries(queryGroups)) {
      if (totalResultsFound >= targetCount) {
        console.log(`Already found ${totalResultsFound} items, skipping ${level} queries`);
        continue;
      }
      
      console.log(`\nSearching ${level} queries (${queries.length} terms) - currently have ${totalResultsFound} items`);
      
      // Calculate remaining items needed
      const remainingNeeded = targetCount - totalResultsFound;
      const relevanceThreshold = this.getRelevanceThresholdForLevel(level);
      
      // Search for market data using the specificity level's queries
      const levelResults = await this.marketData.searchMarketData(
        queries,
        value,              // Target value for reference
        false,              // Not for justification
        relevanceThreshold, // Adjust relevance threshold based on specificity level
        remainingNeeded     // Limit search to only what we still need
      );
      
      console.log(`${level} search results:`);
      levelResults.forEach(result => {
        console.log(`- "${result.query}": ${result.data.length} items (relevance: ${result.relevance})`);
      });
      
      // Process results in order of relevance within this level: very high, high, medium, broad
      const relevanceOrder = ['very high', 'high', 'medium', 'broad'];
      const newItemsFromLevel: SimplifiedAuctionItem[] = [];
      
      for (const relevanceLevel of relevanceOrder) {
        const relevantResults = levelResults.filter(r => r.relevance === relevanceLevel);
        
        for (const result of relevantResults) {
          for (const item of result.data) {
            // Create a unique key for each item to avoid duplicates
            const itemKey = `${item.title}|${item.house}|${item.date}|${item.price}`;
            
            if (!seenTitles.has(itemKey)) {
              newItemsFromLevel.push(item);
              seenTitles.add(itemKey);
            }
          }
        }
      }
      
      // Add items from this level to the overall results
      allItems.push(...newItemsFromLevel);
      totalResultsFound = allItems.length;
      
      console.log(`Found ${newItemsFromLevel.length} new items from ${level} queries`);
      console.log(`Total unique items so far: ${totalResultsFound}`);
      
      // If we found a significant number of items (5+ for very specific, 10+ for others)
      // from this level and we're at or near our target, stop searching
      const significantThreshold = level === 'very specific' ? 5 : 10;
      if (newItemsFromLevel.length >= significantThreshold && totalResultsFound >= targetCount * 0.8) {
        console.log(`Found significant number of items (${newItemsFromLevel.length}) at ${level} level, terminating search early`);
        break;
      }
    }
    
    // Log summary of gathered data
    console.log(`\nSearch complete - total unique auction items gathered: ${allItems.length}`);
    if (allItems.length > 0) {
      const priceStats = {
        min: Math.min(...allItems.map(item => item.price)),
        max: Math.max(...allItems.map(item => item.price)),
        avg: allItems.reduce((sum, item) => sum + item.price, 0) / allItems.length
      };
      console.log(`Price range: $${priceStats.min} - $${priceStats.max} (avg: $${Math.round(priceStats.avg)})`);
    }
    
    // Sort by relevance to target value (closest price first)
    return allItems.sort((a, b) => {
      const diffA = Math.abs(a.price - value);
      const diffB = Math.abs(b.price - value);
      return diffA - diffB;
    });
  }
  
  /**
   * Group search queries by specificity level for progressive searching
   * @param queries Array of search queries
   * @returns Object with queries grouped by specificity level
   */
  private groupQueriesBySpecificity(queries: string[]): Record<string, string[]> {
    // Group queries by word count
    const verySpecific = queries.filter(q => q.split(' ').length >= 5);
    const specific = queries.filter(q => q.split(' ').length >= 3 && q.split(' ').length < 5);
    const moderate = queries.filter(q => q.split(' ').length === 2);
    const broad = queries.filter(q => q.split(' ').length === 1);
    
    // Ensure we have at least one query at each level (use fallbacks if needed)
    const result: Record<string, string[]> = {
      'very specific': verySpecific.length > 0 ? verySpecific : [queries[0]],
      'specific': specific.length > 0 ? specific : (verySpecific.length > 0 ? [verySpecific[0]] : [queries[0]]),
      'moderate': moderate.length > 0 ? moderate : [],
      'broad': broad.length > 0 ? broad : []
    };
    
    // If we don't have moderate queries but have specific ones, create simplified versions
    if (result['moderate'].length === 0 && specific.length > 0) {
      result['moderate'] = specific.map(q => q.split(' ').slice(0, 2).join(' '))
        .filter((q, i, arr) => arr.indexOf(q) === i); // Remove duplicates
    }
    
    // If we don't have broad queries but have moderate ones, take first word
    if (result['broad'].length === 0 && result['moderate'].length > 0) {
      result['broad'] = result['moderate'].map(q => q.split(' ')[0])
        .filter((q, i, arr) => arr.indexOf(q) === i); // Remove duplicates
    }
    
    // Last resort fallback
    if (result['broad'].length === 0) {
      const words = queries[0].split(' ');
      // Try to find a substantial word (not article, etc.) for the broad query
      const potentialBroadWords = words.filter(w => w.length > 3 && !['the', 'and', 'with'].includes(w.toLowerCase()));
      result['broad'] = potentialBroadWords.length > 0 ? [potentialBroadWords[0]] : [words[0]];
    }
    
    return result;
  }
  
  /**
   * Get appropriate relevance threshold based on specificity level
   * @param level Specificity level
   * @returns Relevance threshold
   */
  private getRelevanceThresholdForLevel(level: string): number {
    // Adjust relevance thresholds based on specificity level
    // More specific queries can have higher relevance requirements
    // Broader queries need lower thresholds to find enough items
    switch (level) {
      case 'very specific': return 0.7;  // High relevance for very specific queries
      case 'specific': return 0.5;       // Medium relevance for specific queries
      case 'moderate': return 0.3;       // Lower relevance for moderate queries
      case 'broad': return 0.2;          // Very low relevance for broad queries
      default: return 0.3;               // Default threshold
    }
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
    let formattedSales = sortedResults.map(result => {
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
      // Need to ensure diff is not undefined for type safety
      const typeSafeFormattedSales = formattedSales.map(sale => ({
        ...sale,
        diff: sale.diff || '-'  // Ensure diff is never undefined
      }));
      typeSafeFormattedSales.splice(1, 0, currentItem);
      formattedSales = typeSafeFormattedSales;
    } else {
      formattedSales = [currentItem];
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
   * @param itemValue Target value for comparison
   * @returns Default price history data
   */
  private createDefaultPriceHistory(itemValue: number): PriceHistoryPoint[] {
    // Create a default 6-year price history with slight rising trend
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 5;
    const defaultTrend = 0.05; // 5% annual growth rate
    
    return Array(6).fill(null).map((_, index) => {
      // Calculate year
      const year = (startYear + index).toString();
      
      // Calculate price for this year (starting from approximately 80% of current value)
      const yearFactor = Math.pow(1 + defaultTrend, index);
      const baseValue = itemValue * 0.8;
      const price = Math.round(baseValue * yearFactor);
      
      // Create index based on price (normalized to 1000 for the first year)
      const baseIndex = 1000;
      const indexValue = Math.round(baseIndex * yearFactor);
      
      return { year, price, index: indexValue };
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
   * @param itemValue Target value for the current item
   * @returns Array of price history points by year
   */
  private generatePriceHistory(
    auctionResults: SimplifiedAuctionItem[],
    itemValue: number
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
      return this.createDefaultPriceHistory(itemValue);
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
        return this.createDefaultPriceHistory(itemValue);
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
      return this.createDefaultPriceHistory(itemValue);
    }
  }
  
  /**
   * Generate enhanced statistics for an item
   * @param text Description of the item
   * @param value The target value for comparison
   * @param targetCount Optional target number of auction items to gather (default: 100)
   * @returns Enhanced statistics response
   */
  async generateStatistics(
    text: string, 
    value: number, 
    targetCount: number = 100
  ): Promise<EnhancedStatistics> {
    console.log(`Generating enhanced statistics for "${text}" with value ${value}`);
    console.log(`Target auction data count: ${targetCount} items`);
    
    // Gather comprehensive auction data using improved progressive search strategy
    const startTime = Date.now();
    const auctionData = await this.gatherAuctionData(text, value, targetCount);
    const searchTime = (Date.now() - startTime) / 1000;
    
    console.log(`Found ${auctionData.length} auction items in ${searchTime.toFixed(1)} seconds`);
    
    // Calculate enhanced statistics
    const statistics = this.calculateEnhancedStatistics(auctionData, value);
    
    // Add data quality indicator based on the amount of data found
    const dataQualityIndicator = this.determineDataQuality(auctionData.length, targetCount);
    console.log(`Data quality assessment: ${dataQualityIndicator}`);
    
    // Add data quality to the statistics
    statistics.data_quality = dataQualityIndicator;
    
    return statistics;
  }
  
  /**
   * Determine data quality based on how much auction data was found
   * @param foundCount Number of auction items found
   * @param targetCount Target number of auction items
   * @returns Data quality indicator
   */
  private determineDataQuality(foundCount: number, targetCount: number): string {
    const percentage = (foundCount / targetCount) * 100;
    
    if (foundCount >= targetCount * 0.9) {
      return 'Excellent - Comprehensive market data found';
    } else if (foundCount >= targetCount * 0.7) {
      return 'Good - Substantial market data found';
    } else if (foundCount >= targetCount * 0.4) {
      return 'Moderate - Useful market data found';
    } else if (foundCount >= targetCount * 0.2) {
      return 'Limited - Minimal market data found';
    } else {
      return 'Poor - Very little market data found';
    }
  }
}