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

    const data = await response.json();
    console.log('Valuer service response:', JSON.stringify(data, null, 2));
    return data;
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