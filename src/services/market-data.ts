import { SimplifiedAuctionItem, MarketDataResult } from './types.js';
import { ValuerService } from './valuer.js';
import { trimDescription } from './utils/tokenizer.js';

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
        description: trimDescription(item.lotDescription || '')
      }));

    // Simple approach - limit the maximum number of items we process
    const MAX_ITEMS = 100;
    const result = items.slice(0, MAX_ITEMS);
    
    console.log(`Simplified ${result.length} auction items`);
    return result;
  }

  async searchMarketData(
    searchTerms: string[],
    targetValue?: number,
    isJustify: boolean = false,
    minRelevanceScore: number = 0.5,
    maxResultsNeeded?: number,
    explicitMinPrice?: number,
    explicitMaxPrice?: number
  ): Promise<MarketDataResult[]> {
    const allResults: MarketDataResult[] = [];
    let minPrice: number | undefined;
    let maxPrice: number | undefined;
    let totalItemsFound = 0;

    // If explicit price range is provided, use it
    if (explicitMinPrice !== undefined) {
      minPrice = explicitMinPrice;
    } else if (isJustify && targetValue) {
      // For justify endpoint, use 70%-130% range of target value
      minPrice = Math.floor(targetValue * 0.7);
    } else if (!isJustify) {
      // For find-value and find-value-range endpoints, use minimum threshold
      minPrice = 250;
    }
    
    // If explicit max price is provided, use it
    if (explicitMaxPrice !== undefined) {
      maxPrice = explicitMaxPrice;
    } else if (isJustify && targetValue) {
      // For justify endpoint, use 70%-130% range of target value if not already set
      maxPrice = Math.ceil(targetValue * 1.3);
    }

    console.log('\n=== Starting Market Data Search ===\n');
    console.log('Search terms:', JSON.stringify(searchTerms, null, 2));
    console.log('Minimum relevance score:', minRelevanceScore);
    console.log('Max results needed:', maxResultsNeeded || 'unlimited');
    console.log('Searching with price range:', { minPrice, maxPrice });
    if (explicitMinPrice !== undefined || explicitMaxPrice !== undefined) {
      console.log('Using explicit price range provided by caller');
    } else if (isJustify) {
      console.log('Using justify mode price range (70%-130% of target value)');
    }
    
    // Sort search terms by specificity (number of words)
    const sortedSearchTerms = [...searchTerms].sort((a, b) => 
      b.split(' ').length - a.split(' ').length
    );
    
    // Calculate how many high-quality results we need based on minRelevanceScore and total needed
    let requiredHighRelevanceResults = minRelevanceScore >= 0.7 ? 5 : 3;
    
    // If we're gathering a large dataset, require more high-quality results
    if (maxResultsNeeded && maxResultsNeeded > 50) {
      requiredHighRelevanceResults = Math.min(maxResultsNeeded * 0.2, 15); // 20% of target or max 15
      console.log(`Gathering large dataset (${maxResultsNeeded} items) - requiring ${requiredHighRelevanceResults} high-relevance results`);
    }
    
    for (const query of sortedSearchTerms) {
      // If we've already found enough results for our target and have high relevance matches, we can stop
      if (
        maxResultsNeeded && 
        totalItemsFound >= maxResultsNeeded && 
        allResults.some(r => r.relevance === 'very high' || r.relevance === 'high')
      ) {
        console.log(`\n=== Search Complete (Target Reached) ===`);
        console.log(`Found ${totalItemsFound} items, which meets target of ${maxResultsNeeded}`);
        break;
      }
      
      console.log(`\n=== Searching Term: "${query}" ===`);
      try {
        // Calculate how many more results we need for this query
        const remainingNeeded = maxResultsNeeded ? Math.max(15, maxResultsNeeded - totalItemsFound) : undefined;
        
        // For higher-word-count queries, we use a stricter search
        // For lower-word-count queries, we relax the constraints
        const wordCount = query.split(' ').length;
        const shouldUseStrictSearch = wordCount >= 4;
        const searchLimit = remainingNeeded || (shouldUseStrictSearch ? 30 : 50);
        
        // Adjust price range for broader queries to find more results
        let queryMinPrice = minPrice;
        if (!isJustify && wordCount <= 2 && totalItemsFound < (maxResultsNeeded || 20) * 0.5) {
          // For broad queries, reduce minimum price to cast a wider net if we need more results
          queryMinPrice = queryMinPrice ? Math.floor(queryMinPrice * 0.6) : 100;
          console.log(`Using lower min price (${queryMinPrice}) for broad query to find more results`);
        }
        
        // Send a more focused search for higher relevance scores
        const result = await this.valuer.search(
          query, 
          queryMinPrice, 
          maxPrice, 
          searchLimit  // Set appropriate limit based on how many more results we need
        );
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
        console.log('Simplified data sample (first 5 items):', 
          simplifiedData.slice(0, 5).map(item => ({
            title: item.title,
            price: item.price,
            house: item.house
          }))
        );
        
        console.log(`\nProcessed ${resultCount} items for query "${query}"`);
        
        if (resultCount > 0) {
          // Simplified relevance - just based on query word count
          // This is a temporary solution until a more sophisticated system is implemented later
          const wordCount = query.split(' ').length;
          const relevanceLabel = wordCount >= 4 ? 'very high' : 
                                wordCount >= 3 ? 'high' : 
                                wordCount >= 2 ? 'medium' : 'broad';
          
          console.log(`Simplified relevance assignment: "${relevanceLabel}" (based on ${wordCount} words in query)`);
          
          allResults.push({ 
            query, 
            data: simplifiedData,
            relevance: relevanceLabel
          });
          
          // Update total items found
          const uniqueItems = new Set();
          for (const result of allResults) {
            for (const item of result.data) {
              uniqueItems.add(`${item.title}|${item.house}|${item.date}|${item.price}`);
            }
          }
          totalItemsFound = uniqueItems.size;
          
          console.log(`Total unique items found so far: ${totalItemsFound}`);
          
          // Use simple thresholds for stopping search
          const hasEnoughResults = (
            allResults.filter(r => r.relevance === 'very high' || r.relevance === 'high').length >= 2 &&
            totalItemsFound >= (maxResultsNeeded ? maxResultsNeeded * 0.5 : 20)
          );
          
          if (hasEnoughResults) {
            console.log('\n=== Search Complete (Basic Threshold) ===');
            console.log(`Found sufficient items (${totalItemsFound} total items)`);
            break;
          }
        }

        // Stop if a very broad search returns no results
        if (query.split(' ').length <= 2 && resultCount === 0) {
          console.log('\n=== Search Terminated ===');
          console.log('Broad search returned no results - unlikely to find matches with broader terms');
          break;
        }
      } catch (error) {
        console.warn(`Search failed for term "${query}":`, error);
      }
    }

    // Last resort search if we haven't found anything
    if (allResults.length === 0 && searchTerms.length > 0) {
      // Try to use a meaningful term rather than just the first word
      const words = searchTerms[0].split(' ');
      const potentialTerms = words.filter(w => w.length > 3 && !['the', 'and', 'with', 'for'].includes(w.toLowerCase()));
      const broadestTerm = potentialTerms.length > 0 ? potentialTerms[0] : words[0];
      
      console.log('\n=== Last Resort Search ===');
      console.log('Using broadest term:', broadestTerm);
      try {
        const result = await this.valuer.findSimilarItems(broadestTerm, targetValue);
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
    console.log('Unique items:', totalItemsFound);
    
    return allResults;
  }
}