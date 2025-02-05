import OpenAI from 'openai';
import { ValuerService } from './valuer.js';

interface MarketDataResult {
  query: string;
  data: SimplifiedAuctionItem[];
  relevance?: string;
}

// Rough token estimation based on GPT tokenization rules
function estimateTokens(text: string): number {
  // GPT models typically use ~4 characters per token on average
  return Math.ceil(text.length / 4);
}

const TOKEN_LIMIT = 60000;
const TOKENS_RESERVED = 10000; // Reserve tokens for model reasoning and prompt
const MAX_AVAILABLE_TOKENS = TOKEN_LIMIT - TOKENS_RESERVED;

interface SimplifiedAuctionItem {
  title: string;
  price: number;
  currency: string;
  house: string;
  date: string;
  description?: string;
}

export class JustifierAgent {
  constructor(
    private openai: OpenAI,
    private valuer: ValuerService
  ) {}

  private trimItemDescription(description: string, maxTokens: number): string {
    if (!description) return '';
    const currentTokens = estimateTokens(description);
    if (currentTokens <= maxTokens) return description;
    
    // Trim to approximate token length while keeping whole sentences
    const approxCharLimit = maxTokens * 4;
    const sentences = description.split(/[.!?]+/);
    let result = '';
    let totalChars = 0;
    
    for (const sentence of sentences) {
      const nextLength = totalChars + sentence.length;
      if (nextLength > approxCharLimit) break;
      result += sentence + '.';
      totalChars = nextLength;
    }
    
    return result;
  }

  private simplifyAuctionData(data: any): SimplifiedAuctionItem[] {
    if (!Array.isArray(data?.hits)) {
      return [];
    }

    const items = data.hits
      .filter(item => item && item.lotTitle && item.priceResult)
      .map(item => ({
        title: item.lotTitle,
        price: item.priceResult,
        currency: item.currencyCode || 'USD',
        house: item.houseName || 'Unknown',
        date: item.dateTimeLocal?.split(' ')[0] || 'Unknown', // Only keep the date part
        description: item.lotDescription || ''
      }));

    // Start with a small number of items and gradually add more until we approach the token limit
    let totalTokens = 0;
    const result: SimplifiedAuctionItem[] = [];
    const maxTokensPerItem = Math.floor(MAX_AVAILABLE_TOKENS / Math.min(items.length, 15));

    for (const item of items) {
      // Trim description to fit within per-item token budget
      item.description = this.trimItemDescription(item.description, maxTokensPerItem / 2);
      
      const itemTokens = estimateTokens(
        JSON.stringify(item) + '\n' // Include formatting overhead
      );
      
      if (totalTokens + itemTokens > MAX_AVAILABLE_TOKENS) break;
      
      result.push(item);
      totalTokens += itemTokens;
      
      // Stop after 15 items to ensure we have a good variety without overwhelming
      if (result.length >= 15) break;
    }

    return result;
  }

  private async getSearchStrategy(text: string, value: number): Promise<string[]> {
    const prompt = `
As an antiques expert, analyze this item and suggest search queries in order of specificity, from most specific to most general.
Start with the most precise description that would match this exact item, then progressively broaden the terms.
The goal is to find the most relevant matches first, then fall back to broader categories if needed.

Item: "${text}" (Estimated value: $${value})

Format your response as a JSON array of strings, from most specific to most general. Example:
["Victorian mahogany balloon back dining chair circa 1860",
 "Victorian mahogany dining chair",
 "antique mahogany chair",
 "antique dining chair",
 "antique furniture"]`;

    const completion = await this.openai.chat.completions.create({
      model: "o3-mini",
      messages: [
        {
          role: "assistant",
          content: "You are an expert in antiques and auctions. Your task is to create effective search queries that will find relevant comparable items in auction databases."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    try {
      const queries = JSON.parse(completion.choices[0].message.content || '[]');
      console.log('AI-generated search queries:', queries);
      return Array.isArray(queries) ? queries : [];
    } catch (error) {
      console.warn('Failed to parse AI search queries:', error);
      return [text];
    }
  }

  async justify(text: string, value: number): Promise<string> {
    console.log('Justifying valuation for:', { text, value });
    
    const allSearchTerms = await this.getSearchStrategy(text, value);
    const allResults: MarketDataResult[] = [];
    let totalItems = 0;
    
    // Progressive search strategy
    for (const query of allSearchTerms) {
      console.log('Trying search term:', query);
      try {
        const result = await this.valuer.findSimilarItems(query, value);
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
          
          // If we have enough relevant items, stop searching
          if (totalItems >= 5 && allResults.some(r => r.relevance === 'high')) {
            console.log('Found sufficient relevant items, stopping search');
            break;
          }
        }

        // If this was a very broad search and still no results, stop
        if (query.split(' ').length <= 2 && resultCount === 0) {
          console.log('Even broad search returned no results, stopping');
          break;
        }
      } catch (error) {
        console.warn(`Search failed for term "${query}":`, error);
        continue;
      }
    }

    // If we found no results at all, try one last very broad search
    if (totalItems === 0 && allSearchTerms.length > 0) {
      const broadestTerm = allSearchTerms[allSearchTerms.length - 1].split(' ')[0];
      console.log('Trying last resort broad search with term:', broadestTerm);
      try {
        const result = await this.valuer.findSimilarItems(broadestTerm, value);
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

    // Prepare the prompt with all market data attempts
    const prompt = `
Item to evaluate: "${text}" with proposed value of $${value}

I performed multiple market searches to find comparable items:

${allResults.map((result, index) => `
Search ${index + 1} using term "${result.query}":
Comparable Items:
${result.data.map(item => `
- ${item.title.trim()}
  Price: ${item.currency} ${item.price}
  Auction House: ${item.house}
  Date: ${item.date}
  ${item.description ? `Description: ${item.description.trim()}` : ''}`).join('\n')}
`).join('\n')}

Based on this market data, please provide a detailed justification or challenge of the proposed value.
Consider:
1. How the item's value compares to similar items in the market data
2. The relevance of each search result (${allResults.map(r => `"${r.query}": ${r.relevance}`).join(', ')})
3. Which search provided the most relevant comparables and why
4. Any notable price patterns or trends across the different search results
5. Specific examples that support or challenge the valuation

If the market data is limited or not directly comparable, please:
- Explain why finding exact matches might be challenging
- Use the broader market context from similar categories
- Highlight what factors from the original item might justify price differences
- Suggest what additional information would help refine the valuation

Please provide your analysis in a clear, professional manner with specific references to the market data.`;

    // Get justification from ChatGPT
    const completion = await this.openai.chat.completions.create({
      model: "o3-mini", //o3 mini high is a new model, do not change the model name
      messages: [
        {
          role: "assistant", //role in this model is assistant
          content: "You are an expert antiques and collectibles appraiser. Analyze market data to justify or challenge valuations. When exact matches are scarce, use your expertise to draw insights from broader market patterns and explain your reasoning clearly."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      //do not set temperature or max tokens with this model
    });

    return completion.choices[0].message.content || 'Unable to generate justification';
  }
}