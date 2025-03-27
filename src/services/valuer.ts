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
  
  /**
   * Finds valuable auction results for a given keyword
   * @param keyword User search keyword
   * @param minPrice Minimum price to filter results (default: 1000)
   * @param limit Maximum number of results to return (default: 10)
   * @returns Promise with auction results matching the criteria
   */
  async findValuableResults(keyword: string, minPrice: number = 1000, limit: number = 10): Promise<ValuerSearchResponse> {
    // Search with the original keyword
    let results = await this.search(keyword, minPrice);
    
    // If not enough results, try with a more focused search by removing some words
    if (results.hits.length < limit) {
      const keywords = keyword.split(' ');
      // If we have multiple words, try with fewer words
      if (keywords.length > 1) {
        // Take the most significant words (skip common words like "antique", "vintage", etc.)
        const significantKeywords = keywords
          .filter(word => !['antique', 'vintage', 'old', 'the', 'a', 'an'].includes(word.toLowerCase()))
          .slice(0, 2)
          .join(' ');
          
        if (significantKeywords) {
          const additionalResults = await this.search(significantKeywords, minPrice);
          
          // Merge results, removing duplicates by title
          const existingTitles = new Set(results.hits.map(hit => hit.lotTitle));
          additionalResults.hits.forEach(hit => {
            if (!existingTitles.has(hit.lotTitle)) {
              results.hits.push(hit);
              existingTitles.add(hit.lotTitle);
            }
          });
        }
      }
    }
    
    // Sort by price (highest first) and limit results
    results.hits.sort((a, b) => b.priceResult - a.priceResult);
    results.hits = results.hits.slice(0, limit);
    
    return results;
  }

  async search(query: string, minPrice?: number, maxPrice?: number, limit?: number): Promise<ValuerSearchResponse> {
    const params = new URLSearchParams({
      query,
      ...(minPrice && { 'priceResult[min]': minPrice.toString() }),
      ...(maxPrice && { 'priceResult[max]': maxPrice.toString() }),
      ...(limit && { 'limit': limit.toString() })
    });

    // Add sorting by relevance and date for more accurate results
    params.append('sort', 'relevance');
    
    console.log(`Executing valuer search: ${this.baseUrl}?${params}`);
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
      saleType: lot.saleType,
      lotDescription: lot.description || ''
    }));
    
    // If we specified a limit but got fewer results, add supplementary results
    if (limit && hits.length < limit && minPrice && minPrice > 500) {
      console.log(`Found only ${hits.length} results with price minimum ${minPrice}, trying with lower minimum...`);
      
      // Try with a lower price threshold for supplementary results
      const lowerMinPrice = Math.floor(minPrice * 0.7);
      const supplementaryParams = new URLSearchParams({
        query,
        'priceResult[min]': lowerMinPrice.toString(),
        ...(maxPrice && { 'priceResult[max]': maxPrice.toString() }),
        'limit': (limit - hits.length).toString(),
        'sort': 'relevance'
      });
      
      try {
        const supplementaryResponse = await fetch(`${this.baseUrl}?${supplementaryParams}`);
        if (supplementaryResponse.ok) {
          const supplementaryData = await supplementaryResponse.json() as ValuerResponse;
          const supplementaryLots = Array.isArray(supplementaryData?.data?.lots) ? supplementaryData.data.lots : [];
          
          // Transform and add the supplementary lots
          const existingTitles = new Set(hits.map(hit => hit.lotTitle));
          const supplementaryHits = supplementaryLots
            .map((lot: ValuerLot) => ({
              lotTitle: lot.title,
              priceResult: lot.price.amount,
              currencyCode: lot.price.currency,
              currencySymbol: lot.price.symbol,
              houseName: lot.auctionHouse,
              dateTimeLocal: lot.date,
              lotNumber: lot.lotNumber,
              saleType: lot.saleType,
              lotDescription: lot.description || ''
            }))
            .filter(hit => !existingTitles.has(hit.lotTitle));
            
          hits.push(...supplementaryHits);
          console.log(`Added ${supplementaryHits.length} supplementary results with lower price threshold (${lowerMinPrice})`);
        }
      } catch (error) {
        console.warn('Error fetching supplementary results:', error);
      }
    }
    
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