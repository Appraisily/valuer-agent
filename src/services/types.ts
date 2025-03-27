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