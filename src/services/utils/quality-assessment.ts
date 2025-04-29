import OpenAI from 'openai';
import { SimplifiedAuctionItem, AuctionItemWithRelevance, MarketDataResult } from '../types.js';

/**
 * Select the most relevant auction results to assess based on search specificity priority
 * @param allResults All market data results grouped by search term
 * @param maxResults Maximum number of results to select (default: 20)
 * @returns Array of the most relevant auction results
 */
function selectMostRelevantResults(
  allResults: MarketDataResult[],
  targetValue: number,
  maxResults: number = 20
): SimplifiedAuctionItem[] {
  // First, prioritize results by search specificity
  const relevanceOrder = ['very high', 'high', 'medium', 'broad'];
  let selectedResults: SimplifiedAuctionItem[] = [];
  
  // Try to fill with results in order of search specificity
  for (const relevance of relevanceOrder) {
    const relevantGroups = allResults.filter(r => r.relevance === relevance);
    
    for (const group of relevantGroups) {
      if (selectedResults.length >= maxResults) break;
      
      // For each group, prioritize results with prices closer to target value
      const sortedByRelevance = [...group.data].sort((a, b) => {
        const diffA = Math.abs(a.price - targetValue);
        const diffB = Math.abs(b.price - targetValue);
        return diffA - diffB;
      });
      
      // Add results until we reach max
      const remaining = maxResults - selectedResults.length;
      selectedResults = [...selectedResults, ...sortedByRelevance.slice(0, remaining)];
    }
    
    if (selectedResults.length >= maxResults) break;
  }
  
  // If we didn't get enough results, just add any remaining ones
  if (selectedResults.length < maxResults) {
    const allItems = allResults.flatMap(r => r.data);
    const remainingItems = allItems.filter(item => 
      !selectedResults.some(selected => 
        selected.title === item.title && 
        selected.house === item.house && 
        selected.date === item.date &&
        selected.price === item.price
      )
    );
    const remaining = maxResults - selectedResults.length;
    selectedResults = [...selectedResults, ...remainingItems.slice(0, remaining)];
  }
  
  return selectedResults;
}

/**
 * Uses OpenAI to evaluate the quality/relevance of auction results for the target item.
 * @param openai OpenAI client instance
 * @param targetItemDescription Description of the item being appraised
 * @param targetValue Target value of the item being appraised
 * @param auctionResults Array of auction results found
 * @param allResults Optional full set of results grouped by search term for better prioritization
 * @returns Same auction results with added quality scores
 */
export async function assessAuctionResultsQuality(
  openai: OpenAI,
  targetItemDescription: string,
  targetValue: number,
  auctionResults: SimplifiedAuctionItem[],
  allResults?: MarketDataResult[]
): Promise<AuctionItemWithRelevance[]> {
  if (!auctionResults || auctionResults.length === 0) {
    console.log('No auction results to assess quality');
    return [];
  }

  // Select a limited set of most relevant results if we have the search results available
  let resultsToAssess = auctionResults;
  if (allResults && allResults.length > 0) {
    resultsToAssess = selectMostRelevantResults(allResults, targetValue);
    console.log(`Selected ${resultsToAssess.length} most relevant results for quality assessment (from ${auctionResults.length} total)`);
  } else if (auctionResults.length > 20) {
    // If we don't have search results but have too many items, just sort by price proximity
    resultsToAssess = [...auctionResults]
      .sort((a, b) => {
        const diffA = Math.abs(a.price - targetValue);
        const diffB = Math.abs(b.price - targetValue);
        return diffA - diffB;
      })
      .slice(0, 20);
    console.log(`Selected 20 most price-relevant results for quality assessment (from ${auctionResults.length} total)`);
  }
  
  console.log(`Assessing quality of ${resultsToAssess.length} auction results using OpenAI o3-mini`);
  
  // Create a map to efficiently look up assessed items by a unique key
  const itemKeyMap = new Map<string, number>();
  resultsToAssess.forEach((item, index) => {
    const key = `${item.title}|${item.house}|${item.date}|${item.price}`;
    itemKeyMap.set(key, index);
  });
  
  // Prepare the data for the quality assessment
  const inputData = {
    targetItem: {
      description: targetItemDescription,
      estimatedValue: targetValue
    },
    auctionResults: resultsToAssess.map(item => ({
      title: item.title,
      price: item.price,
      currency: item.currency,
      house: item.house,
      date: item.date,
      description: item.description || ''
    }))
  };

  // Create the prompt for quality assessment
  const prompt = `
I need to assess how relevant each of these auction results is for valuing the target item.

TARGET ITEM:
"${targetItemDescription}" with an estimated value of ${targetValue}.

AUCTION RESULTS:
${JSON.stringify(inputData.auctionResults, null, 2)}

For each auction result, provide a quality score (0-100) indicating how relevant/similar it is to the target item.
Higher scores mean the item is more comparable to the target item and more useful for valuation.

Consider these factors:
- Similarity in artist, medium, size, subject matter, period, condition, etc.
- How well it matches the key attributes of the target item
- Recency of the auction sale
- Reliability of the auction house

Return ONLY a valid JSON object with a "results" array where each object has:
- The original title, price, etc.
- A "quality_score" field (number 0-100)

Example format:
{
  "results": [
    {
      "title": "Original auction title",
      "price": 5000,
      "currency": "USD",
      "house": "Sotheby's",
      "date": "2020-01-01",
      "description": "Original description",
      "quality_score": 85
    },
    ...
  ]
}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "o3-mini",
      messages: [
        { 
          role: "assistant",
          content: "You are an expert in art and antiques valuation with deep knowledge of auction markets. Your task is to assess the relevance/quality of auction results for a specific item valuation." 
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    // Extract the response
    const responseContent = completion.choices[0]?.message?.content;
    if (!responseContent) {
      console.warn('Empty response from OpenAI quality assessment');
      return auctionResults.map(item => ({ ...item, quality_score: 50 }));
    }

    try {
      // Parse the response
      const parsedResponse = JSON.parse(responseContent);
      let scoredItems: any[] = [];
      
      // Extract the scored items based on response structure
      if (parsedResponse?.results && Array.isArray(parsedResponse.results)) {
        scoredItems = parsedResponse.results;
        console.log(`Received quality scores for ${scoredItems.length} items`);
      } else if (Array.isArray(parsedResponse)) {
        scoredItems = parsedResponse;
        console.log(`Received quality scores for ${scoredItems.length} items (direct array)`);
      } else {
        console.warn('Unexpected response format from OpenAI quality assessment');
        return auctionResults.map(item => ({ ...item, quality_score: 50 }));
      }
      
      // Create a map of scored items by their unique key for efficient lookup
      const scoredItemsMap = new Map<string, number>();
      scoredItems.forEach(item => {
        if (item && item.title) {
          const key = `${item.title}|${item.house || ''}|${item.date || ''}|${item.price || 0}`;
          scoredItemsMap.set(key, item.quality_score || 50);
        }
      });

      // Map back the quality scores to all original auction results
      const resultsWithQuality = auctionResults.map(item => {
        const key = `${item.title}|${item.house}|${item.date}|${item.price}`;
        let qualityScore = 50; // Default score
        
        // Check if this item was among those we sent for assessment
        if (itemKeyMap.has(key)) {
          // Look up its quality score
          const index = itemKeyMap.get(key)!;
          if (index < scoredItems.length) {
            qualityScore = scoredItems[index]?.quality_score || 50;
          }
        }
        
        return {
          ...item,
          quality_score: qualityScore
        };
      });
      
      return resultsWithQuality;
      
    } catch (parseError) {
      console.error('Failed to parse OpenAI quality assessment response:', parseError);
      return auctionResults.map(item => ({ ...item, quality_score: 50 }));
    }
  } catch (error) {
    console.error('Error during OpenAI quality assessment:', error);
    return auctionResults.map(item => ({ ...item, quality_score: 50 }));
  }
} 