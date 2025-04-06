import { 
  SimplifiedAuctionItem, 
  EnhancedStatistics, 
  HistogramBucket,
  PriceHistoryPoint
} from './types.js';
import { MarketDataService } from './market-data.js';
import { ValuerService } from './valuer.js';
import OpenAI from 'openai';

// Import the refactored services
import { KeywordExtractionService } from './keyword-extraction.service.js';
import { MarketDataAggregatorService, QueryGroups } from './market-data-aggregator.service.js';
import { StatisticalAnalysisService, CoreStatistics, AdditionalMetrics } from './statistical-analysis.service.js';
import { MarketReportService } from './market-report.service.js';

// Minimum items required for full statistical analysis (consistent with StatisticalAnalysisService logic)
const MIN_ITEMS_FOR_FULL_STATS = 3; 

export class StatisticsService {
  private marketDataService: MarketDataService;
  private keywordExtractionService: KeywordExtractionService;
  private marketDataAggregatorService: MarketDataAggregatorService;
  private statisticalAnalysisService: StatisticalAnalysisService;
  private marketReportService: MarketReportService;
  
  constructor(openai: OpenAI, valuer: ValuerService) {
    this.marketDataService = new MarketDataService(valuer);
    this.keywordExtractionService = new KeywordExtractionService(openai);
    this.marketDataAggregatorService = new MarketDataAggregatorService(this.marketDataService);
    this.statisticalAnalysisService = new StatisticalAnalysisService();
    this.marketReportService = new MarketReportService();
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
    const queryGroups = this.marketDataAggregatorService.groupQueriesBySpecificity(keywords);

    // 2. Gather Auction Data (using the new relevance-focused logic)
    // The aggregator now returns *all* relevant items it found, sorted by price proximity.
    const gatheredAuctionData = await this.marketDataAggregatorService.gatherAuctionDataProgressively(
        queryGroups, value, targetCount, minPrice, maxPrice
    );
    const searchTime = (Date.now() - startTime) / 1000;
    console.log(`Found ${gatheredAuctionData.length} unique, relevant auction items in ${searchTime.toFixed(1)} seconds`);

    // --- Data Consistency: Use gatheredAuctionData for all subsequent steps --- 
    const analysisData = gatheredAuctionData; // Use the full set
    const validAnalysisData = analysisData.filter(
        result => result && typeof result.price === 'number' && !isNaN(result.price) && result.price > 0
    );

    // 3. Calculate Core Statistics (using the consistent dataset)
    const coreStats = this.statisticalAnalysisService.calculateCoreStatistics(validAnalysisData, value);

    // Handle cases with insufficient data for full stats
    if (validAnalysisData.length === 0) {
        console.warn("No valid market data found. Returning minimal report.");
        return this.generateFallbackStatistics(value, analysisData, 'No Data');
    } else if (!coreStats) { // Implies 1 or 2 valid items found
        console.warn(`Insufficient data (${validAnalysisData.length} items) for full statistical analysis. Returning limited report.`);
        return this.generateFallbackStatistics(value, analysisData, 'Limited Data');
    }

    // --- Proceed with full report generation using the consistent analysisData --- 

    // 4. Generate Report Components (Trend, History, Histogram)
    const priceTrendPercentage = this.marketReportService.calculatePriceTrend(analysisData);
    const priceHistory = this.marketReportService.generatePriceHistory(analysisData, value);
    const validPricesForHistogram = validAnalysisData.map(item => item.price).sort((a, b) => a - b);
    const histogram = this.marketReportService.createHistogramBuckets(validPricesForHistogram, value);

    // 5. Calculate Additional Qualitative Metrics (using results from core stats)
    const additionalMetricsInput = {
        zScore: coreStats.z_score,
        percentile: coreStats.target_percentile_raw,
        priceTrend: parseFloat(priceTrendPercentage.replace(/[^-0-9.]/g, '') || '0'),
        coefficientOfVariation: coreStats.coefficient_of_variation,
    };
    const additionalMetrics = this.statisticalAnalysisService.calculateAdditionalMetrics(additionalMetricsInput);
    
    // 6. Format Final Report Components
    const formattedPercentile = this.statisticalAnalysisService.getOrdinalSuffix(coreStats.target_percentile_raw);
    // Format comparables using the consistent data (limit applied later by server.ts)
    const comparableSales = this.marketReportService.formatComparableSales(analysisData, value);
    // Use the actual count of gathered items for data quality assessment
    const dataQuality = this.marketReportService.determineDataQuality(analysisData.length, targetCount);
    const targetMarkerPosition = coreStats.price_max > coreStats.price_min 
        ? ((value - coreStats.price_min) / (coreStats.price_max - coreStats.price_min)) * 100 
        : 50; // Center if min=max

    // 7. Assemble the Final EnhancedStatistics Object
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
   */
  private generateFallbackStatistics(
      targetValue: number, 
      foundData: SimplifiedAuctionItem[],
      reason: 'No Data' | 'Limited Data'
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

      return {
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
  }
}