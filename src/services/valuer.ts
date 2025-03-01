import { ValuerResponse, ValuerLot } from './types.js';

export interface ValuerSearchResponse {
  hits: Array<{
    lotTitle: string;
    priceResult: number;
    currencyCode: string;
    currencySymbol: string;
    houseName: string;
    dateTimeLocal: string;
    lotNumber: string;
    saleType: string;
  }>;
}

export class ValuerService {
  private baseUrl = 'https://valuer-856401495068.us-central1.run.app/api/search';

  async search(query: string, minPrice?: number, maxPrice?: number): Promise<ValuerSearchResponse> {
    const params = new URLSearchParams({
      query,
      ...(minPrice && { 'priceResult[min]': minPrice.toString() }),
      ...(maxPrice && { 'priceResult[max]': maxPrice.toString() })
    });

    const response = await fetch(`${this.baseUrl}?${params}`);

    if (!response.ok) {
      console.error('Valuer service error:', await response.text());
      throw new Error('Failed to fetch from Valuer service');
    }

    const data = await response.json() as ValuerResponse;
    const lots = Array.isArray(data?.data?.lots) ? data.data.lots : [];
    
    // Transform lots into the expected hits format
    const hits = lots.map((lot: ValuerLot) => ({
      lotTitle: lot.title,
      priceResult: lot.price.amount,
      currencyCode: lot.price.currency,
      currencySymbol: lot.price.symbol,
      houseName: lot.auctionHouse,
      dateTimeLocal: lot.date,
      lotNumber: lot.lotNumber,
      saleType: lot.saleType
    }));
    
    console.log('Valuer service raw response (first 10 hits):', {
      total: hits.length,
      firstTenHits: hits.slice(0, 10).map(hit => ({
        lotTitle: hit.lotTitle,
        priceResult: hit.priceResult,
        houseName: hit.houseName
      }))
    });
    
    if (hits.length === 0) {
      console.log('No results found for query:', query);
      console.log('Raw response:', JSON.stringify(data, null, 2));
    }
    
    return { hits };
  }

  async findSimilarItems(description: string, targetValue?: number): Promise<ValuerSearchResponse> {
    if (!targetValue) {
      return this.search(description);
    }
    
    console.log('Searching for similar items:', {
      description,
      targetValue,
      minPrice: Math.floor(targetValue * 0.7),
      maxPrice: Math.ceil(targetValue * 1.3)
    });
    
    const minPrice = Math.floor(targetValue * 0.7);
    const maxPrice = Math.ceil(targetValue * 1.3);

    return this.search(description, minPrice, maxPrice);
  }
}