export class ValuerService {
  private baseUrl = 'https://valuer-856401495068.us-central1.run.app/api/search';

  async search(query: string, minPrice?: number, maxPrice?: number): Promise<any> {
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

    const data: any = await response.json();
    const hits = Array.isArray(data?.results?.[0]?.hits) ? data.results[0].hits : [];
    console.log('Valuer service raw response (first 10 hits):', {
      total: hits.length,
      firstTenHits: hits.slice(0, 10).map((hit: any) => ({
        lotTitle: hit.lotTitle,
        priceResult: hit.priceResult,
        houseName: hit.houseName
      }))
    });
    
    if (hits.length === 0) {
      console.log('No results found for query:', query);
    }
    
    return { hits }; // Return normalized structure with hits array
  }

  async findSimilarItems(description: string, targetValue: number): Promise<any> {
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