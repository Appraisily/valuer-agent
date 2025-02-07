import { SimplifiedAuctionItem, MarketDataResult } from './types.js';
import { ValuerService } from './valuer.js';
import { estimateTokens, trimDescription, MAX_AVAILABLE_TOKENS } from './utils/tokenizer.js';

export class MarketDataService {
  constructor(private valuer: ValuerService) {}

  private simplifyAuctionData(data: { hits?: any[] }): SimplifiedAuctionItem[] {
    if (!Array.isArray(data?.hits)) {
      console.log('No valid hits array in response data');
      console.log('Raw response structure:', JSON.stringify(data, null, 2));
      return [];
    }

    const items = data.hits
      .filter((item): item is NonNullable<typeof item> => 
        Boolean(item && item.lotTitle && item.priceResult))
      .map((item) => ({
        title: item.lotTitle,
        price: item.priceResult,
        currency: item.currencyCode || 'USD',
        house: item.houseName || 'Unknown',
        date: item.dateTimeLocal?.split('T')[0] || 'Unknown',
        description: item.lotDescription || ''
      }));

    let totalTokens = 0;
    const result: SimplifiedAuctionItem[] = [];
    const maxTokensPerItem = Math.floor(MAX_AVAILABLE_TOKENS / Math.min(items.length, 15));

    for (const item of items) {
      const description = trimDescription(item.description, maxTokensPerItem / 2);
      const newItem = { ...item, description };
      
      const itemTokens = estimateTokens(JSON.stringify(newItem) + '\n');
      
      if (totalTokens + itemTokens > MAX_AVAILABLE_TOKENS) break;
      
      result.push(newItem);
      totalTokens += itemTokens;
      
      if (result.length >= 15) break;
    }

    return result;
  }

  async searchMarketData(searchTerms: string[], baseValue?: number): Promise<MarketDataResult[]> {
    const allResults: MarketDataResult[] = [];
    const minPrice = 250; // Set minimum price for all searches
    console.log('\n=== Starting Market Data Search ===\n');
    console.log('Search terms:', JSON.stringify(searchTerms, null, 2));
    
    for (const query of searchTerms) {
      console.log(`\n=== Searching Term: "${query}" ===`);
      try {
        const result = await this.valuer.search(query, minPrice);
        const simplifiedData = this.simplifyAuctionData(result);
        
        console.log('\nRaw data structure:', {
          hasHits: Array.isArray(result?.hits),
          totalHits: result?.hits?.length || 0,
          sampleHit: result?.hits?.[0] ? {
            lotTitle: result.hits[0].lotTitle,
            priceResult: result.hits[0].priceResult
          } : 'No hits'
        });
        
        const resultCount = simplifiedData.length;
        console.log('Simplified data sample (first 10 items):', 
          simplifiedData.slice(0, 10).map(item => ({
            title: item.title,
            price: item.price,
            house: item.house
          }))
        );
        
        console.log(`\nProcessed ${resultCount} items for query "${query}"`);
        
        if (resultCount > 0) {
          allResults.push({ 
            query, 
            data: simplifiedData,
            relevance: resultCount <= 400 ? 'high' : 'broad'
          });
          
          if (allResults.length >= 3 && allResults.some(r => r.relevance === 'high')) {
            console.log('\n=== Search Complete ===');
            console.log('Found sufficient relevant items (3+ results with high relevance)');
            break;
          }
        }

        if (query.split(' ').length <= 2 && resultCount === 0) {
          console.log('\n=== Search Terminated ===');
          console.log('Broad search returned no results');
          break;
        }
      } catch (error) {
        console.warn(`Search failed for term "${query}":`, error);
      }
    }

    if (allResults.length === 0 && searchTerms.length > 0) {
      const broadestTerm = searchTerms[searchTerms.length - 1].split(' ')[0];
      console.log('\n=== Last Resort Search ===');
      console.log('Using broadest term:', broadestTerm);
      try {
        const result = await this.valuer.findSimilarItems(broadestTerm, baseValue);
        const simplifiedData = this.simplifyAuctionData(result);
        allResults.push({ 
          query: broadestTerm, 
          data: simplifiedData,
          relevance: 'broad'
        });
        console.log('Last resort search results:', simplifiedData.length, 'items');
      } catch (error) {
        console.warn('Last resort search failed:', error);
      }
    }

    console.log('\n=== Final Results Summary ===');
    console.log('Total searches completed:', allResults.length);
    console.log('Total items found:', allResults.reduce((sum, r) => sum + r.data.length, 0));
    
    return allResults;
  }
}