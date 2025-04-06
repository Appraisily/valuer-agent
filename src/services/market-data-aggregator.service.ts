import { MarketDataService } from './market-data.js';
import { SimplifiedAuctionItem } from './types.js';

// Type for query groups used in progressive search
export type QueryGroups = Record<string, string[]>;

export class MarketDataAggregatorService {

  constructor(private marketDataService: MarketDataService) {}

  /**
   * Gathers comprehensive auction data using a progressive search strategy based on keyword specificity.
   * @param queryGroups - Keywords grouped by specificity (e.g., 'very specific', 'specific').
   * @param targetValue - The target value for relevance sorting and potential filtering.
   * @param targetCount - The desired number of auction items to gather.
   * @param minPrice - Optional minimum price filter.
   * @param maxPrice - Optional maximum price filter.
   * @returns Array of unique, simplified auction items, sorted by relevance to target value.
   */
  async gatherAuctionDataProgressively(
    queryGroups: QueryGroups,
    targetValue: number,
    targetCount: number = 100,
    minPrice?: number,
    maxPrice?: number
  ): Promise<SimplifiedAuctionItem[]> {
    console.log(`Gathering comprehensive auction data (target: ${targetCount} items)`);

    // Use explicit price range if provided, otherwise calculate based on value
    const effectiveMinPrice = minPrice ?? Math.floor(targetValue * 0.6);
    const effectiveMaxPrice = maxPrice ?? Math.ceil(targetValue * 1.6);
    console.log(`Using price range for search: $${effectiveMinPrice} - $${effectiveMaxPrice}`);

    const allItems: SimplifiedAuctionItem[] = [];
    const seenItemKeys = new Set<string>(); // Use a more robust key
    let totalResultsFound = 0;
    const searchOrder = ['very specific', 'specific', 'moderate', 'broad']; // Define search order

    console.log('Starting progressive search strategy');

    for (const level of searchOrder) {
      const queries = queryGroups[level];
      if (!queries || queries.length === 0 || totalResultsFound >= targetCount) {
        if (totalResultsFound >= targetCount) {
            console.log(`Target count ${targetCount} reached. Skipping remaining levels.`);
        } else {
             console.log(`Skipping level "${level}" due to no queries or target already met.`);
        }
        continue;
      }

      console.log(`\nSearching level "${level}" (${queries.length} terms) - currently have ${totalResultsFound} items`);

      const remainingNeeded = targetCount - totalResultsFound;
      const relevanceThreshold = this.getRelevanceThresholdForLevel(level);

      // Fetch data for the current level
      const levelResults = await this.marketDataService.searchMarketData(
        queries,
        targetValue,          // Target value for reference
        false,                // Not for justification
        relevanceThreshold,   // Relevance threshold for this level
        remainingNeeded,      // Limit API results if possible (or handle client-side)
        effectiveMinPrice,
        effectiveMaxPrice
      );

      console.log(`${level} search raw results:`);
      levelResults.forEach(result => {
        console.log(`- "${result.query}": ${result.data.length} items (relevance: ${result.relevance || 'N/A'})`);
      });

      // Process and deduplicate results from this level
      let newItemsFromLevelCount = 0;
      const relevanceOrder = ['very high', 'high', 'medium', 'broad']; // Process in order of relevance
      
      for (const relevance of relevanceOrder) {
          const relevantGroup = levelResults.filter(r => r.relevance === relevance);
          for (const result of relevantGroup) {
              for (const item of result.data) {
                // Create a unique key based on title, house, date, and price
                const itemKey = `${item.title}|${item.house}|${item.date}|${item.price}`;
                if (!seenItemKeys.has(itemKey)) {
                    allItems.push(item);
                    seenItemKeys.add(itemKey);
                    newItemsFromLevelCount++;
                    if (allItems.length >= targetCount) break; // Stop if target reached
                }
              }
              if (allItems.length >= targetCount) break;
          }
          if (allItems.length >= targetCount) break;
      }
      

      totalResultsFound = allItems.length;
      console.log(`Found ${newItemsFromLevelCount} new unique items from level "${level}"`);
      console.log(`Total unique items so far: ${totalResultsFound}`);

      // Optional: Early exit condition if enough good data found
      const significantThreshold = level === 'very specific' ? 5 : 10;
      if (newItemsFromLevelCount >= significantThreshold && totalResultsFound >= targetCount * 0.8) {
        console.log(`Found significant items at level "${level}", terminating search early.`);
        break;
      }
    }

    console.log(`\nSearch complete - total unique auction items gathered: ${allItems.length}`);
    this.logPriceSummary(allItems);

    // Final sort by relevance to target value (closest price first)
    return allItems.sort((a, b) => {
      const diffA = Math.abs(a.price - targetValue);
      const diffB = Math.abs(b.price - targetValue);
      return diffA - diffB;
    });
  }

  /**
   * Groups search queries by specificity level based on word count.
   * Ensures each level has at least some queries, using fallbacks if necessary.
   * @param queries - Flat array of search queries.
   * @returns Object with queries grouped by specificity level.
   */
  groupQueriesBySpecificity(queries: string[]): QueryGroups {
      if (!queries || queries.length === 0) {
          console.warn("Received empty query list for grouping.");
          return { 'very specific': [], 'specific': [], 'moderate': [], 'broad': [] };
      }
      
      const groups: QueryGroups = {
        'very specific': queries.filter(q => q.split(' ').length >= 5),
        'specific': queries.filter(q => q.split(' ').length >= 3 && q.split(' ').length < 5),
        'moderate': queries.filter(q => q.split(' ').length === 2),
        'broad': queries.filter(q => q.split(' ').length === 1)
      };
      
      // Simple fallback: Ensure 'very specific' and 'specific' have the first query if empty
      if (groups['very specific'].length === 0) groups['very specific'].push(queries[0]);
      if (groups['specific'].length === 0) groups['specific'].push(queries[0]);
      
      // Fallback for moderate/broad: derive from more specific queries if empty
      if (groups['moderate'].length === 0 && groups['specific'].length > 0) {
          groups['moderate'] = [...new Set(groups['specific'].map(q => q.split(' ').slice(0, 2).join(' ')))];
      }
      if (groups['broad'].length === 0 && groups['moderate'].length > 0) {
          groups['broad'] = [...new Set(groups['moderate'].map(q => q.split(' ')[0]))];
      }
       // Last resort for broad
      if (groups['broad'].length === 0 && queries.length > 0) {
           const words = queries[0].split(' ');
           const potentialBroad = words.filter(w => w.length > 2 && !['the', 'and', 'with', 'for', 'from'].includes(w.toLowerCase()));
           groups['broad'].push(potentialBroad.length > 0 ? potentialBroad[0] : words[0]);
      }

      // Ensure all levels exist, even if empty
      groups['very specific'] = groups['very specific'] || [];
      groups['specific'] = groups['specific'] || [];
      groups['moderate'] = groups['moderate'] || [];
      groups['broad'] = groups['broad'] || [];
      
      return groups;
  }

  /**
   * Determines the relevance threshold based on the query specificity level.
   * @param level - Specificity level string.
   * @returns Relevance threshold number.
   */
  private getRelevanceThresholdForLevel(level: string): number {
    switch (level) {
      case 'very specific': return 0.7;
      case 'specific': return 0.5;
      case 'moderate': return 0.3;
      case 'broad': return 0.2;
      default: return 0.3;
    }
  }

  private logPriceSummary(items: SimplifiedAuctionItem[]): void {
      if (items.length > 0) {
        const prices = items.map(item => item.price).filter(p => p > 0);
        if(prices.length > 0) {
            const stats = {
              min: Math.min(...prices),
              max: Math.max(...prices),
              avg: prices.reduce((sum, item) => sum + item, 0) / prices.length
            };
            console.log(`Price range of gathered items: $${stats.min} - $${stats.max} (avg: $${Math.round(stats.avg)})`);
        } else {
             console.log("No valid prices found in gathered items.");
        }
      } else {
          console.log("No items gathered to calculate price summary.");
      }
  }
} 