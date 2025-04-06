import { ValuerResponse, ValuerLot } from './types.js';

// Define the structure for a transformed hit
interface ValuerHit {
  lotTitle: string;
  priceResult: number;
  currencyCode: string;
  currencySymbol: string;
  houseName: string;
  dateTimeLocal: string;
  lotNumber: string;
  saleType: string;
  lotDescription?: string; // Added optional description
}

// Update ValuerSearchResponse to use the ValuerHit interface
export interface ValuerSearchResponse {
  hits: ValuerHit[];
}

// Helper function to transform ValuerLot to ValuerHit
function transformValuerLotToHit(lot: ValuerLot): ValuerHit {
  return {
    lotTitle: lot.title,
    priceResult: lot.price.amount,
    currencyCode: lot.price.currency,
    currencySymbol: lot.price.symbol,
    houseName: lot.auctionHouse,
    dateTimeLocal: lot.date,
    lotNumber: lot.lotNumber,
    saleType: lot.saleType,
    lotDescription: lot.description || ''
  };
}

export class ValuerService {
  private baseUrl = 'https://valuer-856401495068.us-central1.run.app/api/search';

  /**
   * Core search function to fetch results from the Valuer API.
   * Focuses on executing a single search request.
   * @param query Search query string
   * @param minPrice Optional minimum price filter
   * @param maxPrice Optional maximum price filter
   * @param limit Optional limit for the number of results from the API
   * @returns Promise with the raw search results (hits)
   */
  async search(query: string, minPrice?: number, maxPrice?: number, limit?: number): Promise<ValuerSearchResponse> {
    const params = new URLSearchParams({
      query,
      ...(minPrice !== undefined && { 'priceResult[min]': minPrice.toString() }),
      ...(maxPrice !== undefined && { 'priceResult[max]': maxPrice.toString() }),
      ...(limit !== undefined && { 'limit': limit.toString() })
    });

    // Add sorting by relevance
    params.append('sort', 'relevance');

    console.log(`Executing valuer search: ${this.baseUrl}?${params}`);
    const response = await fetch(`${this.baseUrl}?${params}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Valuer service error:', errorBody);
      throw new Error(`Failed to fetch from Valuer service: ${response.statusText}`);
    }

    const data = await response.json() as ValuerResponse;
    const lots = Array.isArray(data?.data?.lots) ? data.data.lots : [];

    // Use the helper function for transformation
    const hits = lots.map(transformValuerLotToHit);

    console.log(`Valuer service raw response for query "${query}" (found ${hits.length} hits):
      First 10 titles: ${hits.slice(0, 10).map(h => h.lotTitle).join(', ')}`);

    if (hits.length === 0) {
      console.log('No results found for query:', query);
      // console.log('Raw response:', JSON.stringify(data, null, 2)); // Optionally log full raw response on no results
    }

    return { hits };
  }

  /**
   * Finds valuable auction results for a given keyword, potentially refining the search.
   * Handles retrying with a simpler keyword if initial results are insufficient.
   * @param keyword User search keyword
   * @param minPrice Minimum price to filter results (default: 1000)
   * @param limit Maximum number of results to return *after* merging and sorting (default: 10)
   * @returns Promise with auction results matching the criteria, sorted and limited.
   */
  async findValuableResults(keyword: string, minPrice: number = 1000, limit: number = 10): Promise<ValuerSearchResponse> {
    // Initial search with the original keyword and a potentially larger internal limit
    // Fetch more initially (e.g., limit * 2) to allow for better merging/filtering later
    const initialLimit = limit * 2;
    let results = await this.search(keyword, minPrice, undefined, initialLimit);
    const allHits = [...results.hits];
    const seenTitles = new Set(allHits.map(hit => hit.lotTitle));

    // If not enough results, try with a more focused search by removing some words
    if (allHits.length < limit) {
      const keywords = keyword.split(' ');
      if (keywords.length > 1) {
        const significantKeywords = keywords
          .filter(word => !['antique', 'vintage', 'old', 'the', 'a', 'an'].includes(word.toLowerCase()))
          .slice(0, 3) // Use up to 3 significant keywords
          .join(' ');

        if (significantKeywords && significantKeywords !== keyword) {
          console.log(`Initial search for "${keyword}" yielded ${allHits.length} results (less than limit ${limit}). Retrying with "${significantKeywords}"`);
          // Fetch remaining needed results with the refined query
          const remainingLimit = initialLimit - allHits.length;
          const additionalResults = await this.search(significantKeywords, minPrice, undefined, remainingLimit > 0 ? remainingLimit : undefined);

          // Merge results, removing duplicates by title
          additionalResults.hits.forEach(hit => {
            if (!seenTitles.has(hit.lotTitle)) {
              allHits.push(hit);
              seenTitles.add(hit.lotTitle);
            }
          });
          console.log(`Found ${additionalResults.hits.length} additional results. Total unique hits: ${allHits.length}`);
        }
      }
    }

    // Sort all collected hits by price (highest first) and apply the final limit
    allHits.sort((a, b) => b.priceResult - a.priceResult);
    const finalHits = allHits.slice(0, limit);

    console.log(`Returning ${finalHits.length} final results for "${keyword}" after sorting and limiting.`);

    return { hits: finalHits };
  }

  /**
   * Finds items similar to a description within a specific price range.
   * @param description Item description used as search query
   * @param targetValue Optional target value to define price range
   * @returns Promise with auction results within the price range.
   */
  async findSimilarItems(description: string, targetValue?: number): Promise<ValuerSearchResponse> {
    if (!targetValue) {
      // If no target value, just search with a default limit
      return this.search(description, undefined, undefined, 20);
    }

    // Calculate a price range around the target value
    const minPrice = Math.floor(targetValue * 0.7);
    const maxPrice = Math.ceil(targetValue * 1.3);

    console.log('Searching for similar items:', {
      description,
      targetValue,
      minPrice,
      maxPrice
    });

    // Search within the calculated price range, limit results
    return this.search(description, minPrice, maxPrice, 20); // Limit results for similarity search
  }
}