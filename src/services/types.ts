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
export interface ValueRangeResponse {
  minValue: number;
  maxValue: number;
  mostLikelyValue: number;
  explanation: string;
}