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

    return response.json();
  }

  async findSimilarItems(description: string, targetValue: number): Promise<ValuerResponse> {
    // Search within a price range of ±30% of the target value
    const minPrice = Math.floor(targetValue * 0.7);
    const maxPrice = Math.ceil(targetValue * 1.3);

    return this.search(description, minPrice, maxPrice);
  }
}