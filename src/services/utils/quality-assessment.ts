import OpenAI from 'openai';
import { SimplifiedAuctionItem, AuctionItemWithRelevance } from '../types.js';

/**
 * Uses OpenAI to evaluate the quality/relevance of auction results for the target item.
 * @param openai OpenAI client instance
 * @param targetItemDescription Description of the item being appraised
 * @param targetValue Target value of the item being appraised
 * @param auctionResults Array of auction results found
 * @returns Same auction results with added quality scores
 */
export async function assessAuctionResultsQuality(
  openai: OpenAI,
  targetItemDescription: string,
  targetValue: number,
  auctionResults: SimplifiedAuctionItem[]
): Promise<AuctionItemWithRelevance[]> {
  if (!auctionResults || auctionResults.length === 0) {
    console.log('No auction results to assess quality');
    return [];
  }

  console.log(`Assessing quality of ${auctionResults.length} auction results using OpenAI o3-mini`);
  
  // Prepare the data for the quality assessment
  const inputData = {
    targetItem: {
      description: targetItemDescription,
      estimatedValue: targetValue
    },
    auctionResults: auctionResults.map(item => ({
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

Return ONLY a valid JSON array where each object has the original auction data plus a 'quality_score' field.
Example format:
[
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
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "o3-mini", // Specified model as requested
      messages: [
        { 
          role: "assistant", // Changed from "system" to "assistant" as required
          content: "You are an expert in art and antiques valuation with deep knowledge of auction markets. Your task is to assess the relevance/quality of auction results for a specific item valuation." 
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
      // Removed temperature parameter which is not supported by o3-mini
    });

    // Extract the response
    const responseContent = completion.choices[0]?.message?.content;
    if (!responseContent) {
      console.warn('Empty response from OpenAI quality assessment');
      return auctionResults as AuctionItemWithRelevance[];
    }

    try {
      // Parse the response and extract the scored results
      const parsedResponse = JSON.parse(responseContent);
      
      // Check if response has the expected format (array of items with quality_score)
      if (Array.isArray(parsedResponse.results)) {
        const scoredResults = parsedResponse.results;
        console.log(`Received quality scores for ${scoredResults.length} items`);
        
        // Merge the quality scores with the original auction results
        const resultsWithQuality = auctionResults.map((originalItem, index) => {
          const scoredItem = scoredResults[index] || {};
          return {
            ...originalItem,
            quality_score: scoredItem.quality_score || 50 // Default to 50 if missing
          };
        });
        
        return resultsWithQuality;
      } else if (Array.isArray(parsedResponse)) {
        // Direct array response
        const scoredResults = parsedResponse;
        console.log(`Received quality scores for ${scoredResults.length} items (direct array)`);
        
        // Map back to original items to preserve all fields
        const resultsWithQuality = auctionResults.map((originalItem, index) => {
          const scoredItem = scoredResults[index] || {};
          return {
            ...originalItem,
            quality_score: scoredItem.quality_score || 50 // Default to 50 if missing
          };
        });
        
        return resultsWithQuality;
      }
      
      console.warn('Unexpected response format from OpenAI quality assessment:', parsedResponse);
      return auctionResults as AuctionItemWithRelevance[];
    } catch (parseError) {
      console.error('Failed to parse OpenAI quality assessment response:', parseError);
      console.log('Raw response:', responseContent);
      return auctionResults as AuctionItemWithRelevance[];
    }
  } catch (error) {
    console.error('Error during OpenAI quality assessment:', error);
    return auctionResults as AuctionItemWithRelevance[];
  }
} 