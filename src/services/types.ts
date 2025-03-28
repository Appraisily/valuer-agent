export interface SimplifiedAuctionItem {
  title: string;
  price: number;
  currency: string;
  house: string;
  date: string;
  description?: string;
}

export interface MarketDataResult {
  query: string;
  data: SimplifiedAuctionItem[];
  relevance?: string;
}

export interface ValueResponse {
  value: number;
  explanation: string;
}

export interface JustifyResponse {
  explanation: string;
  auctionResults: SimplifiedAuctionItem[];
  allSearchResults?: MarketDataResult[]; // All results from search queries
}

export interface ValuerLot {
  title: string;
  price: {
    amount: number;
    currency: string;
    symbol: string;
  };
  auctionHouse: string;
  date: string;
  lotNumber: string;
  saleType: string;
  description?: string;
}

export interface ValuerResponse {
  success: boolean;
  timestamp: string;
  parameters: {
    query: string;
    priceResult?: {
      min: string;
      max: string;
    };
  };
  data: {
    lots: ValuerLot[];
    totalResults: number;
  };
}
export interface AuctionItemWithRelevance extends SimplifiedAuctionItem {
  relevanceScore?: number;
  adjustmentFactor?: number;
  relevanceReason?: string;
}

export interface ValueRangeResponse {
  minValue: number;
  maxValue: number;
  mostLikelyValue: number;
  explanation: string;
  auctionResults: AuctionItemWithRelevance[];
  confidenceLevel: number;
  marketTrend: 'rising' | 'stable' | 'declining';
  keyFactors?: string[];
  dataQuality?: 'high' | 'medium' | 'low';
}

// Interface for histogram bucket data in enhanced statistics
export interface HistogramBucket {
  min: number;
  max: number;
  count: number;
  position: number;
  height: number;
  contains_target: boolean;
}

// Price history data point for yearly trend analysis
export interface PriceHistoryPoint {
  year: string; // Year as string (e.g., "2020")
  price: number; // Average price for that year
  index?: number; // Optional market index value
}

// Interface for comprehensive market statistics
export interface EnhancedStatistics {
  count: number;
  average_price: number;
  median_price: number;
  price_min: number;
  price_max: number;
  standard_deviation: number;
  coefficient_of_variation: number;
  percentile: string;
  confidence_level: string;
  price_trend_percentage: string;
  histogram: HistogramBucket[];
  comparable_sales: SimplifiedAuctionItem[];
  value: number;
  target_marker_position: number;
  total_count?: number; // For when we limit the displayed results
  
  // Additional fields for enhanced visualization
  price_history: PriceHistoryPoint[]; // Yearly price history data
  historical_significance: number; // Historical significance score (0-100)
  investment_potential: number; // Investment potential score (0-100)
  provenance_strength: number; // Provenance strength score (0-100)
}

// Response for the enhanced-statistics endpoint
export interface EnhancedStatisticsResponse {
  success: boolean;
  statistics: EnhancedStatistics;
  all_auction_results: SimplifiedAuctionItem[]; // All auction results found
}