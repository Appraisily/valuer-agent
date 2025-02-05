interface ValuerResponse {
  success: boolean;
  data: Array<{
    title: string;
    price: number;
    description?: string;
  }>;
}

export class ValuerService {
  private baseUrl = 'https://valuer-856401495068.us-central1.run.app/api/search';

  /**
   * Searches for similar items in the auction database.
   * 
   * @param query - The search query (e.g., "Victorian mahogany table")
   * @param minPrice - Optional minimum price filter
   * @param maxPrice - Optional maximum price filter
   * @returns Promise<ValuerResponse> - Array of similar items with their prices
   * 
   * Example usage:
   * ```typescript
   * const results = await valuer.search("Tiffany lamp", 1000, 5000);
   * ```
   */
  async search(query: string, minPrice?: number, maxPrice?: number): Promise<ValuerResponse> {
    const params = new URLSearchParams({
      query,
      ...(minPrice && { 'priceResult[min]': minPrice.toString() }),
      ...(maxPrice && { 'priceResult[max]': maxPrice.toString() })
    });

    const response = await fetch(`${this.baseUrl}?${params}`);

    if (!response.ok) {
      throw new Error('Failed to fetch from Valuer service');
    }

    const data = await response.json() as ValuerResponse;
    
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Invalid response format from Valuer service');
    }
    
    return data;
  }

  /**
   * Finds similar items within a price range of ±30% of the target value.
   * 
   * @param description - Item description (e.g., "Antique Victorian mahogany dining table")
   * @param targetValue - The value to compare against (e.g., 2500)
   * @returns Promise<ValuerResponse> - Array of comparable items
   * 
   * Example usage:
   * ```typescript
   * const comparables = await valuer.findSimilarItems("Antique Victorian chair", 1500);
   * ```
   */
  async findSimilarItems(description: string, targetValue: number): Promise<ValuerResponse> {
    // Search within a price range of ±30% of the target value
    const minPrice = Math.floor(targetValue * 0.7);
    const maxPrice = Math.ceil(targetValue * 1.3);

    return this.search(description, minPrice, maxPrice);
  }
}