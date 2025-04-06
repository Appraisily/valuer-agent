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

export class StatisticsService {
  private marketDataService: MarketDataService;
  private keywordExtractionService: KeywordExtractionService;
  private marketDataAggregatorService: MarketDataAggregatorService;
  private statisticalAnalysisService: StatisticalAnalysisService;
  private marketReportService: MarketReportService;
  
  constructor(openai: OpenAI, valuer: ValuerService) {
    // Keep MarketDataService initialization if it's used by aggregator internally
    this.marketDataService = new MarketDataService(valuer);
    
    // Initialize the new services
    this.keywordExtractionService = new KeywordExtractionService(openai);
    this.marketDataAggregatorService = new MarketDataAggregatorService(this.marketDataService);
    this.statisticalAnalysisService = new StatisticalAnalysisService();
    this.marketReportService = new MarketReportService();
  }
  
  /**
   * Generate enhanced statistics for an item by orchestrating calls to specialized services.
   * @param text Description of the item
   * @param value The target value for comparison
   * @param targetCount Optional target number of auction items to gather (default: 100)
   * @param minPrice Optional minimum price filter for data gathering.
   * @param maxPrice Optional maximum price filter for data gathering.
   * @returns Enhanced statistics response object.
   */
  async generateStatistics(
    text: string, 
    value: number, 
    targetCount: number = 100,
    minPrice?: number,
    maxPrice?: number
  ): Promise<EnhancedStatistics> {
    console.log(`Generating enhanced statistics for "${text.substring(0, 100)}..." with value ${value}`);
    console.log(`Target auction data count: ${targetCount} items`);
    console.log(`Price range filter: ${minPrice ? '$' + minPrice : 'auto'} - ${maxPrice ? '$' + maxPrice : 'auto'}`);
    
    const startTime = Date.now();

    // 1. Extract Keywords
    const keywords = await this.keywordExtractionService.extractKeywords(text);
    const queryGroups = this.marketDataAggregatorService.groupQueriesBySpecificity(keywords);

    // 2. Gather Auction Data
    const auctionData = await this.marketDataAggregatorService.gatherAuctionDataProgressively(
        queryGroups, value, targetCount, minPrice, maxPrice
    );
    const searchTime = (Date.now() - startTime) / 1000;
    console.log(`Found ${auctionData.length} unique auction items in ${searchTime.toFixed(1)} seconds`);

    // 3. Calculate Core Statistics
    const coreStats = this.statisticalAnalysisService.calculateCoreStatistics(auctionData, value);

    // Handle case where no valid data is found for stats
    if (!coreStats) {
        console.warn("Insufficient data for statistical analysis. Returning default report.");
        return this.generateDefaultStatistics(value, targetCount);
    }

    // 4. Generate Report Components (Trend, History, Histogram, Comparables)
    const priceTrendPercentage = this.marketReportService.calculatePriceTrend(auctionData);
    const priceHistory = this.marketReportService.generatePriceHistory(auctionData, value);
    const validPrices = auctionData.map(item => item.price).filter(p => p > 0).sort((a, b) => a - b);
    const histogram = this.marketReportService.createHistogramBuckets(validPrices, value);
    // Note: Comparable sales formatting happens later, after additional metrics if needed

    // 5. Calculate Additional Qualitative Metrics
    const additionalMetricsInput = {
        zScore: coreStats.z_score,
        percentile: coreStats.target_percentile_raw,
        priceTrend: parseFloat(priceTrendPercentage.replace(/[^-0-9.]/g, '') || '0'), // Ensure numeric trend
        coefficientOfVariation: coreStats.coefficient_of_variation,
    };
    const additionalMetrics = this.statisticalAnalysisService.calculateAdditionalMetrics(additionalMetricsInput);
    
    // 6. Format Final Report Components
    const formattedPercentile = this.statisticalAnalysisService.getOrdinalSuffix(coreStats.target_percentile_raw);
    const comparableSales = this.marketReportService.formatComparableSales(auctionData, value); // Format now
    const dataQuality = this.marketReportService.determineDataQuality(auctionData.length, targetCount);
    const targetMarkerPosition = coreStats.price_max > coreStats.price_min 
        ? ((value - coreStats.price_min) / (coreStats.price_max - coreStats.price_min)) * 100 
        : 50; // Center if min=max

    // 7. Assemble the Final EnhancedStatistics Object
    const enhancedStats: EnhancedStatistics = {
        // Core Stats
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
        // Report Components
        price_trend_percentage: priceTrendPercentage,
        histogram: histogram,
        comparable_sales: comparableSales, // Use formatted sales
        target_marker_position: Math.max(0, Math.min(100, targetMarkerPosition)), // Clamp between 0-100
        price_history: priceHistory,
        // Additional Metrics
        historical_significance: additionalMetrics.historical_significance,
        investment_potential: additionalMetrics.investment_potential,
        provenance_strength: additionalMetrics.provenance_strength,
        // Metadata
        data_quality: dataQuality,
        total_count: auctionData.length > 100 ? auctionData.length : undefined, // Indicate if data was capped for stats
    };
    
    console.log(`Data quality assessment: ${dataQuality}`);
    return enhancedStats;
  }

  /**
   * Generates a default EnhancedStatistics object when insufficient data is available.
   */
  private generateDefaultStatistics(targetValue: number, targetCount: number): EnhancedStatistics {
      const defaultHistory = this.marketReportService.generatePriceHistory([], targetValue);
      const defaultHistogram = this.marketReportService.createHistogramBuckets([], targetValue);
      const defaultComparables = this.marketReportService.formatComparableSales([], targetValue);
      const defaultDataQuality = this.marketReportService.determineDataQuality(0, targetCount);
      
      // Calculate default additional metrics based on zero/default inputs
      const defaultAdditionalMetrics = this.statisticalAnalysisService.calculateAdditionalMetrics({ 
          zScore: 0, percentile: 50, priceTrend: 0, coefficientOfVariation: 100 // Assume high variation
      });

      return {
          count: 0,
          average_price: 0,
          median_price: 0,
          price_min: 0,
          price_max: 0,
          standard_deviation: 0,
          coefficient_of_variation: 0,
          percentile: '50th', // Default percentile
          confidence_level: 'Low (Limited Data)',
          value: targetValue,
          price_trend_percentage: '+0.0%',
          histogram: defaultHistogram,
          comparable_sales: defaultComparables,
          target_marker_position: 50,
          price_history: defaultHistory,
          historical_significance: defaultAdditionalMetrics.historical_significance,
          investment_potential: defaultAdditionalMetrics.investment_potential,
          provenance_strength: defaultAdditionalMetrics.provenance_strength,
          data_quality: defaultDataQuality,
      };
  }
}