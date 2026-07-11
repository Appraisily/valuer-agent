export interface ValuerLot {
  id?: string;
  lot_uid?: string;
  lotRef?: string | null;
  lot_ref?: string | null;
  title: string | null;
  description?: string | null;
  price?: {
    amount?: number;
    currency?: string | null;
    symbol?: string | null;
  };
  auctionHouse?: string | null;
  houseName?: string | null;
  house?: string | null;
  date?: string | null;
  dateTimeLocal?: string | null;
  auctionDate?: string | null;
  lotNumber?: string | null;
  saleType?: string | null;
  url?: string | null;
  lot_url?: string | null;
  lotUrl?: string | null;
  source_url?: string | null;
  sourceUrl?: string | null;
  thumbUrl?: string | null;
  imageUrl?: string | null;
  originalUrl?: string | null;
  imageOriginalUrl?: string | null;
  imagePath?: string | null;
  imageFileName?: string | null;
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
