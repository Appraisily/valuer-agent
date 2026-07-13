export interface ValuerLot {
  schemaVersion: 1;
  lotUid: string;
  lotRef?: string | null;
  title: string | null;
  description?: string | null;
  houseName?: string | null;
  saleType?: string | null;
  auctionDate?: string | null;
  priceRealised?: number | null;
  currency?: string | null;
  estimateMin?: number | null;
  estimateMax?: number | null;
  lotNumber?: string | null;
  sourceUrl?: string | null;
  rankingScore?: number | null;
  imageUrl?: string | null;
  assetStatus: 'available' | 'unavailable' | 'unknown';
  assetVerifiedAt?: string | null;
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
