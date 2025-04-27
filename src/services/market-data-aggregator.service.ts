import { MarketDataService } from './market-data.js';
import { SimplifiedAuctionItem, MarketDataResult } from './types.js';

// Type for query groups used in progressive search
export type QueryGroups = Record<string, string[]>;

const MAX_SEARCH_LEVELS = 5; // Maximum progressive search levels
const MIN_RELEVANT_ITEMS = 5; // Minimum items to stop searching early
const TARGET_COUNT_FALLBACK_MULTIPLIER = 2; // Factor to multiply targetCount for broad search if needed

export class MarketDataAggregatorService {

  constructor(private marketDataService: MarketDataService) {}

  /**
   * Gathers auction data prioritizing relevance over strict target count, with a limited number of search attempts.
   * @param queryGroups - Keywords grouped by specificity.
   * @param targetValue - The target value for relevance sorting.
   * @param targetCount - The *initial* desired number of items (influences early search attempts).
   * @param minPrice - Optional minimum price filter.
   * @param maxPrice - Optional maximum price filter.
   * @returns Array of unique, simplified auction items, sorted by relevance (price proximity).
   */
  async gatherAuctionDataProgressively(
    queryGroups: QueryGroups,
    targetValue: number,
    targetCount: number = 100,
    minPrice?: number,
    maxPrice?: number
  ): Promise<SimplifiedAuctionItem[]> {
    console.log(`Gathering auction data (initial target: ${targetCount}, min items: ${MIN_RELEVANT_ITEMS}, max levels: ${MAX_SEARCH_LEVELS})`);

    const effectiveMinPrice = minPrice ?? Math.floor(targetValue * 0.6);
    const effectiveMaxPrice = maxPrice ?? Math.ceil(targetValue * 1.6);
    console.log(`Using price range for search: $${effectiveMinPrice} - $${effectiveMaxPrice}`);

    const allItems: SimplifiedAuctionItem[] = [];
    const seenItemKeys = new Set<string>();
    let currentLevel = 0;
    // Define search order - ensure it has levels for MAX_SEARCH_LEVELS + potential broad level
    const searchOrder = ['very specific', 'specific', 'moderate', 'broad', 'very broad']; // Added 'very broad' for clarity

    console.log('Starting progressive search strategy');

    for (const level of searchOrder) {
        currentLevel++;
        if (currentLevel > MAX_SEARCH_LEVELS) {
            console.log(`Reached max search levels (${MAX_SEARCH_LEVELS}).`);
            break;
        }

        const queries = queryGroups[level];
        if (!queries || queries.length === 0) {
            console.log(`Skipping level ${currentLevel} ("${level}") due to no queries.`);
            continue;
        }

        console.log(`\n--- Level ${currentLevel} ("${level}"): Searching ${queries.length} terms (Current items: ${allItems.length}) ---`);

        // Adjust remaining needed based on progress, but ensure we ask for a reasonable amount initially
        // Ask for at least double the min needed or half the target
        const remainingNeeded = Math.max(targetCount * 0.5, MIN_RELEVANT_ITEMS * 2) - allItems.length;
        const relevanceThreshold = this.getRelevanceThresholdForLevel(level);

        // Fetch data for the current level
        const levelResults = await this.fetchAndProcessLevel(
            queries,
            targetValue,
            relevanceThreshold,
            Math.max(10, remainingNeeded), // Ask API for at least 10, or remainingNeeded
            effectiveMinPrice,
            effectiveMaxPrice
        );

        // Process and deduplicate results from this level
        const newItemsCount = this.addUniqueItems(levelResults, allItems, seenItemKeys);
        console.log(`Level ${currentLevel} ("${level}"): Found ${newItemsCount} new unique items. Total unique items: ${allItems.length}`);

        // Check if we've reached our target count - only stop then
        if (allItems.length >= targetCount) {
            console.log(`Target count (${targetCount}) reached at level ${currentLevel}. Stopping progressive search.`);
            break;
        }
        
        // Log for MIN_RELEVANT_ITEMS but don't stop searching
        if (allItems.length >= MIN_RELEVANT_ITEMS) {
            console.log(`Minimum relevant items (${MIN_RELEVANT_ITEMS}) threshold reached at level ${currentLevel}. Continuing search to find more items.`);
        }
    } // End of progressive search loop

    // --- Final Broad Search (if needed) ---
    if (allItems.length < MIN_RELEVANT_ITEMS) {
        console.log(`\n--- Final Attempt: Minimum items (${MIN_RELEVANT_ITEMS}) not met. Performing broader search. ---`);
        // Use 'broad' and 'very broad' queries, or derive if necessary
        let finalQueries = queryGroups['broad'] || [];
        if (queryGroups['very broad']) {
             finalQueries = [...new Set([...finalQueries, ...queryGroups['very broad']])];
        }
        // Fallback: if still no queries, try deriving from specific/moderate
         if (finalQueries.length === 0) {
            const specific = queryGroups['specific'] || [];
            const moderate = queryGroups['moderate'] || [];
            const potential = [...specific, ...moderate].map(q => q.split(' ').slice(0, 2).join(' ')).filter(q => q);
            finalQueries = [...new Set(potential)];
             console.log("Deriving final broad queries:", finalQueries);
         }


        if (finalQueries.length > 0) {
            const finalResults = await this.fetchAndProcessLevel(
                finalQueries,
                targetValue,
                0.1, // Lowest relevance threshold
                targetCount * TARGET_COUNT_FALLBACK_MULTIPLIER, // Ask for more items in the broad search
                effectiveMinPrice * 0.5, // Broaden price range slightly
                effectiveMaxPrice * 1.5
            );
             const finalNewCount = this.addUniqueItems(finalResults, allItems, seenItemKeys);
             console.log(`Final Attempt: Added ${finalNewCount} more items. Total unique items: ${allItems.length}`);
        } else {
            console.log("Final Attempt: No broad queries available to run.");
        }
    }
    
    // Add an extra attempt if we're still far from our target count
    if (allItems.length < targetCount * 0.5 && currentLevel <= MAX_SEARCH_LEVELS) {
        console.log(`\n--- Extra Search Attempt: Only found ${allItems.length}/${targetCount} items. Trying broader search. ---`);
        
        // Combine all query levels, prioritizing broader terms as they might find different results
        let extraQueries = [
            ...(queryGroups['broad'] || []), 
            ...(queryGroups['moderate'] || []),
            ...(queryGroups['specific'] || [])
        ].slice(0, 10); // Limit to 10 queries to avoid excessive searching
        
        if (extraQueries.length > 0) {
            console.log(`Executing ${extraQueries.length} extra queries with expanded price range`);
            const extraResults = await this.fetchAndProcessLevel(
                extraQueries,
                targetValue,
                0.1, // Very low relevance threshold
                targetCount - allItems.length, // Try to find remaining items
                effectiveMinPrice * 0.5, // Much broader price range
                effectiveMaxPrice * 2
            );
            const extraCount = this.addUniqueItems(extraResults, allItems, seenItemKeys);
            console.log(`Extra Search: Added ${extraCount} more items. Total unique items: ${allItems.length}`);
        }
    }

    console.log(`\n--- Search Complete ---`);
    console.log(`Total unique auction items gathered: ${allItems.length}`);
    this.logPriceSummary(allItems);

    // Final sort by relevance (price proximity) regardless of how many items were found
    allItems.sort((a, b) => {
      const diffA = Math.abs(a.price - targetValue);
      const diffB = Math.abs(b.price - targetValue);
      return diffA - diffB;
    });

    // Add relevance score based on final sorted position (optional)
    // allItems.forEach((item, index) => {
    //     item.relevanceScore = 1 - (index / allItems.length); // Simple linear score
    // });

    return allItems; // Return all gathered and sorted items
  }

   /** Helper function to fetch and log results for a level */
   private async fetchAndProcessLevel(
       queries: string[],
       targetValue: number,
       relevanceThreshold: number,
       maxResultsNeeded: number,
       minPrice?: number,
       maxPrice?: number
   ): Promise<MarketDataResult[]> {
        const levelResults = await this.marketDataService.searchMarketData(
            queries,
            targetValue,
            false, // Not for justification
            relevanceThreshold,
            Math.max(10, Math.ceil(maxResultsNeeded)), // Ensure maxResultsNeeded is an int >= 10
            minPrice,
            maxPrice
        );

        console.log(`  Raw results for this level:`);
        levelResults.forEach(result => {
            console.log(`  - "${result.query}": ${result.data.length} items (relevance: ${result.relevance || 'N/A'})`);
        });
        return levelResults;
   }

   /** Helper function to add unique items to the main list */
    private addUniqueItems(
        levelResults: MarketDataResult[],
        allItems: SimplifiedAuctionItem[],
        seenItemKeys: Set<string>
    ): number {
        let newItemsCount = 0;
        const relevanceOrder = ['very high', 'high', 'medium', 'broad']; // Process in order of specified relevance if available

        for (const relevance of relevanceOrder) {
            const relevantGroup = levelResults.filter(r => r.relevance === relevance);
            for (const result of relevantGroup) {
                for (const item of result.data) {
                    // Create a unique key
                    const itemKey = `${item.title}|${item.house}|${item.date}|${item.price}`;
                    if (!seenItemKeys.has(itemKey)) {
                        allItems.push(item);
                        seenItemKeys.add(itemKey);
                        newItemsCount++;
                    }
                }
            }
        }
         // Add items with no specific relevance score last
         const otherResults = levelResults.filter(r => !r.relevance || !relevanceOrder.includes(r.relevance));
         for (const result of otherResults) {
             for (const item of result.data) {
                 const itemKey = `${item.title}|${item.house}|${item.date}|${item.price}`;
                 if (!seenItemKeys.has(itemKey)) {
                     allItems.push(item);
                     seenItemKeys.add(itemKey);
                     newItemsCount++;
                 }
             }
         }
        return newItemsCount;
    }


  /**
   * Groups search queries by specificity level.
   * Ensures levels potentially used in broad search exist.
   */
  groupQueriesBySpecificity(queries: string[]): QueryGroups {
      if (!queries || queries.length === 0) {
          console.warn("Received empty query list for grouping.");
          return { 'very specific': [], 'specific': [], 'moderate': [], 'broad': [], 'very broad': [] };
      }
      
      // Check if we're receiving the new structured 5-10-5-5 format (25 total queries)
      if (queries.length === 25) {
        // New structured format - use the predefined slices
        console.log("Using structured keyword format (5-10-5-5)");
        const groups: QueryGroups = {
          'very specific': queries.slice(0, 5),
          'specific': queries.slice(5, 15),
          'moderate': queries.slice(15, 20),
          'broad': queries.slice(20, 25),
          'very broad': [] // Initially empty, will be populated from broad if needed
        };
        
        // Add some very broad terms for emergency fallback
        groups['very broad'] = groups['broad'].flatMap(q => q.split(' ')).filter(w => 
          w.length > 2 && !['the','a','an','is','at','on','in','for','of'].includes(w.toLowerCase())
        );
        
        console.log("Structured Query Groups:", JSON.stringify(groups));
        return groups;
      }
      
      // Fallback to original method for backward compatibility
      console.log("Using traditional keyword grouping (not structured 5-10-5-5 format)");
      const groups: QueryGroups = {
        'very specific': queries.filter(q => q.split(' ').length >= 5),
        'specific': queries.filter(q => q.split(' ').length >= 3 && q.split(' ').length < 5),
        'moderate': queries.filter(q => q.split(' ').length === 2),
        'broad': queries.filter(q => q.split(' ').length === 1),
        'very broad': [] // Initially empty, populated by fallback
      };

      // --- Fallback Logic ---      
      const allSourceQueries = queries.join(' ').split(' ').filter(w => w.length > 1); // Get all words

      // Simple fallback: Ensure 'very specific' and 'specific' have the most specific query if empty
      if (groups['very specific'].length === 0 && queries[0]) groups['very specific'].push(queries[0]);
      if (groups['specific'].length === 0 && groups['very specific'].length > 0) {
          // Try deriving from 'very specific' first
           groups['specific'] = [...new Set(groups['very specific'].map(q => q.split(' ').slice(0, 4).join(' ')).filter(q => q && q.split(' ').length >=3))];
           if (groups['specific'].length === 0 && queries[0]) groups['specific'].push(queries[0]); // Use original if derivation fails
      } else if (groups['specific'].length === 0 && queries[0]) {
           groups['specific'].push(queries[0]); // Use original if 'very specific' was also empty
      }

      // Fallback for moderate: derive from 'specific'
      if (groups['moderate'].length === 0 && groups['specific'].length > 0) {
          groups['moderate'] = [...new Set(groups['specific'].map(q => q.split(' ').slice(0, 2).join(' ')).filter(q => q && q.split(' ').length === 2))];
      }
      // Fallback for broad: derive from 'moderate'
      if (groups['broad'].length === 0 && groups['moderate'].length > 0) {
          groups['broad'] = [...new Set(groups['moderate'].map(q => q.split(' ')[0]).filter(q => q && q.length > 1))];
      }
      // Fallback for 'very broad': use single words from 'broad', or from 'moderate' if 'broad' failed
       if (groups['very broad'].length === 0) {
           const sourceForVeryBroad = groups['broad'].length > 0 ? groups['broad'] : (groups['moderate'].length > 0 ? groups['moderate'] : groups['specific']);
           // Use unique single words from the source level
            groups['very broad'] = [...new Set(sourceForVeryBroad.flatMap(q => q.split(' ')).filter(w => w.length > 2 && !['the','a','an','is','at','on','in','for','of'].includes(w.toLowerCase())))]; 
            // If still empty, use all words from original queries
            if(groups['very broad'].length === 0) {
                 groups['very broad'] = [...new Set(allSourceQueries.filter(w => w.length > 2))];
            }
       }

       // Last resort for broad/very broad if everything else failed
       if (groups['broad'].length === 0 && allSourceQueries.length > 0) {
            groups['broad'] = [allSourceQueries[0]]; // Use the first word
       }
        if (groups['very broad'].length === 0 && groups['broad'].length > 0) {
             groups['very broad'] = groups['broad']; // If broad has something but very broad doesn't, copy it
        }
         if (groups['very broad'].length === 0 && allSourceQueries.length > 0) { // Ultimate fallback for very broad
              groups['very broad'] = [allSourceQueries[0]];
         }

      // Ensure all levels exist, even if empty
      groups['very specific'] = groups['very specific'] || [];
      groups['specific'] = groups['specific'] || [];
      groups['moderate'] = groups['moderate'] || [];
      groups['broad'] = groups['broad'] || [];
      groups['very broad'] = groups['very broad'] || []; // Ensure it exists

      console.log("Traditional Query Groups:", JSON.stringify(groups));
      return groups;
  }

  /**
   * Determines the relevance threshold based on the query specificity level.
   */
  private getRelevanceThresholdForLevel(level: string): number {
    switch (level) {
      case 'very specific': return 0.7;
      case 'specific': return 0.5;
      case 'moderate': return 0.3;
      case 'broad': return 0.2;
      case 'very broad': return 0.1; // Lower threshold for the broadest level
      default: return 0.3;
    }
  }

  /** Logs a summary of prices for the gathered items */
  private logPriceSummary(items: SimplifiedAuctionItem[]): void {
       if (items.length > 0) {
        const prices = items.map(item => item.price).filter(p => typeof p === 'number' && !isNaN(p) && p > 0);
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