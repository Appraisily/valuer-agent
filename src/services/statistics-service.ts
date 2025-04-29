import { 
  SimplifiedAuctionItem, 
  EnhancedStatistics,
  // Removed: HistogramBucket,
  // Removed: PriceHistoryPoint
} from './types.js';
import { MarketDataService } from './market-data.js';
import { ValuerService } from './valuer.js';
import OpenAI from 'openai';

// Import the refactored services
import { KeywordExtractionService } from './keyword-extraction.service.js';
// Removed: QueryGroups
import { MarketDataAggregatorService } from './market-data-aggregator.service.js';
// Removed: CoreStatistics, AdditionalMetrics
import { StatisticalAnalysisService } from './statistical-analysis.service.js';
import { MarketReportService } from './market-report.service.js';
import { assessAuctionResultsQuality } from './utils/quality-assessment.js';

// Removed unused const: MIN_ITEMS_FOR_FULL_STATS

export class StatisticsService {
  private marketDataService: MarketDataService;
  private keywordExtractionService: KeywordExtractionService;
  private marketDataAggregatorService: MarketDataAggregatorService;
  private statisticalAnalysisService: StatisticalAnalysisService;
  private marketReportService: MarketReportService;
  private openai: OpenAI;
  
  constructor(openai: OpenAI, valuer: ValuerService) {
    this.marketDataService = new MarketDataService(valuer);
    this.keywordExtractionService = new KeywordExtractionService(openai);
    this.marketDataAggregatorService = new MarketDataAggregatorService(this.marketDataService);
    this.statisticalAnalysisService = new StatisticalAnalysisService();
    this.marketReportService = new MarketReportService();
    this.openai = openai;
  }
  
  /**
   * Generate enhanced statistics for an item using a consistent dataset gathered by the aggregator.
   * @param text Description of the item
   * @param value The target value for comparison
   * @param targetCount Initial target for the aggregator (influences search effort)
   * @param minPrice Optional minimum price filter for data gathering.
   * @param maxPrice Optional maximum price filter for data gathering.
   * @returns Enhanced statistics response object.
   */
  async generateStatistics(
    text: string, 
    value: number, 
    targetCount: number = 100, // Initial target for aggregator
    minPrice?: number,
    maxPrice?: number
  ): Promise<EnhancedStatistics> {
    console.log(`Generating enhanced statistics for "${text.substring(0, 100)}..." with value ${value}`);
    console.log(`Initial target auction data count for aggregator: ${targetCount} items`);
    console.log(`Price range filter: ${minPrice ? '$' + minPrice : 'auto'} - ${maxPrice ? '$' + maxPrice : 'auto'}`);
    
    const startTime = Date.now();

    // 1. Extract Keywords
    const keywords = await this.keywordExtractionService.extractKeywords(text);
    
    // Structure keywords by category for inclusion in the response
    const very_specific = keywords.slice(0, 5);
    const specific = keywords.slice(5, 15);
    const moderate = keywords.slice(15, 20);
    const broad = keywords.slice(20, 25);
    
    const queryGroups = this.marketDataAggregatorService.groupQueriesBySpecificity(keywords);

    // 2. Gather Auction Data (using the new relevance-focused logic)
    // The aggregator now returns *all* relevant items it found, sorted by price proximity.
    const gatherResult = await this.marketDataAggregatorService.gatherAuctionDataProgressively(
        queryGroups, value, targetCount, minPrice, maxPrice
    );
    const gatheredAuctionData = gatherResult.items;
    const keywordCounts = gatherResult.keywordCounts;
    
    const searchTime = (Date.now() - startTime) / 1000;
    console.log(`\nAuction data gathering complete: ${gatheredAuctionData.length} unique items found in ${searchTime.toFixed(1)}s`);

    // 3. Check if we have sufficient data for analysis
    if (gatheredAuctionData.length === 0) {
      console.warn('No auction data found for statistical analysis. Using fallback approach.');
      // Return minimal statistics with explanation
      const keywordCategories = {
        very_specific: very_specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        specific: specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        moderate: moderate.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        broad: broad.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
      };
      return this.generateFallbackStatistics(value, gatheredAuctionData, 'No Data', keywordCategories);
    } else if (gatheredAuctionData.length < 5) {
      console.warn(`Limited auction data found (${gatheredAuctionData.length} items). Using fallback approach.`);
      // Return limited statistics with explanation
      const keywordCategories = {
        very_specific: very_specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        specific: specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        moderate: moderate.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        broad: broad.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
      };
      return this.generateFallbackStatistics(value, gatheredAuctionData, 'Limited Data', keywordCategories);
    }

    // Convert QueryGroups to MarketDataResult format for assessAuctionResultsQuality
    const queryGroupsAsResults = Object.entries(queryGroups).flatMap(([level, queries]) => {
      // Map relevance level to corresponding relevance label
      const relevanceLabel = 
        level === 'very specific' ? 'very high' :
        level === 'specific' ? 'high' :
        level === 'moderate' ? 'medium' : 'broad';
      
      // Create a MarketDataResult for each query in this group
      return queries.map(query => {
        // Find auction results for this query
        const count = keywordCounts.get(query) || 0;
        // Get the data items for this query - we have to approximate them
        // by filtering the gathered data for items with matching titles
        const data = count > 0 ? 
          gatheredAuctionData.filter(item => 
            item.title.toLowerCase().includes(query.toLowerCase())
          ) : [];
        
        return {
          query,
          data,
          relevance: relevanceLabel
        };
      });
    });

    // NEW STEP: Assess quality of auction results using AI
    const auctionDataWithQuality = await assessAuctionResultsQuality(
      this.openai,
      text,
      value,
      gatheredAuctionData,
      queryGroupsAsResults.filter(r => r.data.length > 0) // Only pass results with data
    );

    // --- Data Consistency: Use the quality-assessed data for all subsequent steps --- 
    const analysisData = auctionDataWithQuality; // Use the full set with quality scores
    const validAnalysisData = analysisData.filter(
        result => result && typeof result.price === 'number' && !isNaN(result.price) && result.price > 0
    );

    // 4. Calculate Core Statistics (using the consistent dataset)
    const coreStats = this.statisticalAnalysisService.calculateCoreStatistics(validAnalysisData, value);

    // Handle cases with insufficient data for full stats
    if (validAnalysisData.length === 0) {
        console.warn("No valid market data found. Returning minimal report.");
        const keywordCategories = {
          very_specific: very_specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          specific: specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          moderate: moderate.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          broad: broad.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        };
        return this.generateFallbackStatistics(value, analysisData, 'No Data', keywordCategories);
    } else if (!coreStats) { // Implies 1 or 2 valid items found
        console.warn(`Insufficient data (${validAnalysisData.length} items) for full statistical analysis. Returning limited report.`);
        const keywordCategories = {
          very_specific: very_specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          specific: specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          moderate: moderate.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          broad: broad.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
        };
        return this.generateFallbackStatistics(value, analysisData, 'Limited Data', keywordCategories);
    }

    // --- Proceed with full report generation using the consistent analysisData --- 

    // 5. Generate Report Components (Trend, History, Histogram)
    const priceTrendPercentage = this.marketReportService.calculatePriceTrend(analysisData);
    const priceHistory = this.marketReportService.generatePriceHistory(analysisData, value);
    const validPricesForHistogram = validAnalysisData.map(item => item.price).sort((a, b) => a - b);
    const histogram = this.marketReportService.createHistogramBuckets(validPricesForHistogram, value);

    // 6. Calculate Additional Qualitative Metrics (using results from core stats)
    const additionalMetricsInput = {
        zScore: coreStats.z_score,
        percentile: coreStats.target_percentile_raw,
        priceTrend: parseFloat(priceTrendPercentage.replace(/[^-0-9.]/g, '') || '0'),
        coefficientOfVariation: coreStats.coefficient_of_variation,
    };
    const additionalMetrics = this.statisticalAnalysisService.calculateAdditionalMetrics(additionalMetricsInput);
    
    // 7. Format Final Report Components
    const formattedPercentile = this.statisticalAnalysisService.getOrdinalSuffix(coreStats.target_percentile_raw);
    // Format comparables using the consistent data (limit applied later by server.ts)
    const comparableSales = this.marketReportService.formatComparableSales(analysisData, value);
    // Use the actual count of gathered items for data quality assessment
    // Pass the auction results with quality scores
    const dataQuality = this.marketReportService.determineDataQuality(
      analysisData.length, 
      targetCount, 
      auctionDataWithQuality // Pass the quality-scored auction results
    );
    const targetMarkerPosition = coreStats.price_max > coreStats.price_min 
        ? ((value - coreStats.price_min) / (coreStats.price_max - coreStats.price_min)) * 100 
        : 50; // Center if min=max

    // 8. Assemble the Final EnhancedStatistics Object
    const enhancedStats: EnhancedStatistics = {
        // Core Stats from the analysisData subset
        count: coreStats.count,
        average_price: coreStats.average_price,
        median_price: coreStats.median_price,
        price_min: coreStats.price_min,
        price_max: coreStats.price_max,
        standard_deviation: coreStats.standard_deviation,
        coefficient_of_variation: coreStats.coefficient_of_variation,
        percentile: formattedPercentile,
        confidence_level: coreStats.confidence_level,
        value: value,
        // Report Components from analysisData
        price_trend_percentage: priceTrendPercentage,
        histogram: histogram,
        comparable_sales: comparableSales, // Full formatted list; server applies UI limit
        target_marker_position: Math.max(0, Math.min(100, targetMarkerPosition)),
        price_history: priceHistory,
        // Additional Metrics
        historical_significance: additionalMetrics.historical_significance,
        investment_potential: additionalMetrics.investment_potential,
        provenance_strength: additionalMetrics.provenance_strength,
        // Metadata
        data_quality: dataQuality,
        // Include search keywords information
        search_keywords: {
          very_specific: very_specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          specific: specific.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          moderate: moderate.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          broad: broad.map(keyword => ({keyword, count: keywordCounts.get(keyword) || 0})),
          total_count: keywords.length
        }
        // total_count is removed - added by server.ts if it limits comparable_sales
    };
    
    console.log(`Data quality assessment: ${dataQuality}`);
    return enhancedStats;
  }

  /**
   * Generates a fallback EnhancedStatistics object when insufficient data is available for full analysis.
   * @param targetValue The target value.
   * @param foundData The (potentially empty or very small) list of items found by the aggregator.
   * @param reason The reason for fallback ('No Data' or 'Limited Data').
   * @param keywordCategories Optional keyword categories to include in the response.
   */
  private generateFallbackStatistics(
      targetValue: number, 
      foundData: SimplifiedAuctionItem[],
      reason: 'No Data' | 'Limited Data',
      keywordCategories?: {
        very_specific: { keyword: string; count: number }[];
        specific: { keyword: string; count: number }[];
        moderate: { keyword: string; count: number }[];
        broad: { keyword: string; count: number }[];
      }
  ): EnhancedStatistics {
      const count = foundData.length;
      const confidence = reason === 'No Data' ? 'Poor - No Data' : `Limited (${count} item${count !== 1 ? 's' : ''})`
      
      // Generate default/minimal components
      const defaultHistory = this.marketReportService.generatePriceHistory(foundData, targetValue); // Still attempt history
      const validPrices = foundData.map(item => item.price).filter(p => p > 0).sort((a, b) => a - b);
      const defaultHistogram = this.marketReportService.createHistogramBuckets(validPrices, targetValue); // Attempt histogram
      const defaultComparables = this.marketReportService.formatComparableSales(foundData, targetValue);
      const defaultDataQuality = this.marketReportService.determineDataQuality(count, 0); // Pass 0 as target count was irrelevant here
      
      // Calculate default additional metrics
      const defaultAdditionalMetrics = this.statisticalAnalysisService.calculateAdditionalMetrics({ 
          zScore: 0, percentile: 50, priceTrend: 0, coefficientOfVariation: 100
      });
      
      // Find min/max from the limited data if available
      const priceMin = validPrices.length > 0 ? Math.round(validPrices[0]) : 0;
      const priceMax = validPrices.length > 0 ? Math.round(validPrices[validPrices.length - 1]) : 0;

      const result: EnhancedStatistics = {
        count: count, // Actual count found
        average_price: 0, // Cannot calculate reliably
        median_price: 0, // Cannot calculate reliably
        price_min: priceMin,
        price_max: priceMax,
        standard_deviation: 0, // Cannot calculate reliably
        coefficient_of_variation: 0, // Cannot calculate reliably
        percentile: count > 0 ? 'N/A' : '50th', 
        confidence_level: confidence,
        value: targetValue,
        price_trend_percentage: '+0.0%', // Cannot calculate trend reliably
        histogram: defaultHistogram,
        comparable_sales: defaultComparables, // Show the few items found
        target_marker_position: 50, // Default marker position
        price_history: defaultHistory,
        historical_significance: defaultAdditionalMetrics.historical_significance,
        investment_potential: defaultAdditionalMetrics.investment_potential,
        provenance_strength: defaultAdditionalMetrics.provenance_strength,
        data_quality: defaultDataQuality,
      };
      
      // Add keyword information if available
      if (keywordCategories) {
        result.search_keywords = {
          ...keywordCategories,
          total_count: 
            keywordCategories.very_specific.length + 
            keywordCategories.specific.length + 
            keywordCategories.moderate.length + 
            keywordCategories.broad.length
        };
      }
      
      return result;
  }
}