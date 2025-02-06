import { SimplifiedAuctionItem, MarketDataResult } from './types';
import { ValuerService } from './valuer.js';
import { estimateTokens, trimDescription, MAX_AVAILABLE_TOKENS } from './utils/tokenizer';

export class MarketDataService {
  constructor(private valuer: ValuerService) {}

  private simplifyAuctionData(data: any): SimplifiedAuctionItem[] {
    if (!Array.isArray(data?.hits)) {
      return [];
    }

    const items = data.hits
      .filter((item: any) => item && item.lotTitle && item.priceResult)
      .map((item: any) => ({
        title: item.lotTitle,
        price: item.priceResult,
        currency: item.currencyCode || 'USD',
        house: item.houseName || 'Unknown',
        date: item.dateTimeLocal?.split(' ')[0] || 'Unknown',
        description: item.lotDescription || ''
      }));

    let totalTokens = 0;
    const result: SimplifiedAuctionItem[] = [];
    const maxTokensPerItem = Math.floor(MAX_AVAILABLE_TOKENS / Math.min(items.length, 15));

    for (const item of items) {
      item.description = trimDescription(item.description, maxTokensPerItem / 2);
      
      const itemTokens = estimateTokens(JSON.stringify(item) + '\n');
      
      if (totalTokens + itemTokens > MAX_AVAILABLE_TOKENS) break;
      
      result.push(item);
      totalTokens += itemTokens;
      
      if (result.length >= 15) break;
    }

    return result;
  }

  async searchMarketData(searchTerms: string[], baseValue: number): Promise<MarketDataResult[]> {
    const allResults: MarketDataResult[] = [];
    let totalItems = 0;
    
    for (const query of searchTerms) {
      console.log('Trying search term:', query);
      try {
        const result = await this.valuer.findSimilarItems(query, baseValue);
        const simplifiedData = this.simplifyAuctionData(result);
        const resultCount = simplifiedData.length;
        console.log(`Search "${query}" returned ${resultCount} results`);
        
        if (resultCount > 0) {
          totalItems += resultCount;
          allResults.push({ 
            query, 
            data: simplifiedData,
            relevance: resultCount <= 400 ? 'high' : 'broad'
          });
          
          if (totalItems >= 5 && allResults.some(r => r.relevance === 'high')) {
            console.log('Found sufficient relevant items, stopping search');
            break;
          }
        }

        if (query.split(' ').length <= 2 && resultCount === 0) {
          console.log('Even broad search returned no results, stopping');
          break;
        }
      } catch (error) {
        console.warn(`Search failed for term "${query}":`, error);
      }
    }

    if (totalItems === 0 && searchTerms.length > 0) {
      const broadestTerm = searchTerms[searchTerms.length - 1].split(' ')[0];
      console.log('Trying last resort broad search with term:', broadestTerm);
      try {
        const result = await this.valuer.findSimilarItems(broadestTerm, baseValue);
        const simplifiedData = this.simplifyAuctionData(result);
        allResults.push({ 
          query: broadestTerm, 
          data: simplifiedData,
          relevance: 'broad'
        });
      } catch (error) {
        console.warn('Last resort search failed:', error);
      }
    }

    return allResults;
  }
}