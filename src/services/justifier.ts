import OpenAI from 'openai';
import { ValuerService } from './valuer.js';
import { trimDescription, MAX_DESCRIPTION_LENGTH } from './utils/tokenizer.js';

interface MarketDataResult {
  query: string;
  data: SimplifiedAuctionItem[];
  relevance?: string;
}

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

  private trimItemDescription(description: string): string {
    return trimDescription(description);
  }

  private simplifyAuctionData(data: any): SimplifiedAuctionItem[] {
    if (!Array.isArray(data?.hits)) {
      return [];
    }

    interface AuctionItem {
      lotTitle: string;
      priceResult: number;
      currencyCode?: string;
      houseName?: string;
      dateTimeLocal?: string;
      lotDescription?: string;
    }

    const items = data.hits
      .filter((item: AuctionItem) => item && item.lotTitle && item.priceResult)
      .map((item: AuctionItem) => ({
        title: item.lotTitle,
        price: item.priceResult,
        currency: item.currencyCode || 'USD',
        house: item.houseName || 'Unknown',
        date: item.dateTimeLocal?.split(' ')[0] || 'Unknown', // Only keep the date part
        description: this.trimItemDescription(item.lotDescription || '')
      }));

    // Limit to 15 items max for justification purposes
    return items.slice(0, 15);
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

Here are the most relevant auction results found for comparison (all auction details are verifiable):

${allResults.map(result => `
${result.relevance === 'high' ? 'Direct Matches' : 'Related Items'} (Search: "${result.query}"):

${result.data.map(item => `
• Lot Title: "${item.title.trim()}"
  Sale: ${item.house} - ${item.date}
  Realized Price: ${item.currency} ${item.price.toLocaleString()}
  ${item.description ? `Details: ${item.description.trim()}` : ''}`).join('\n\n')}
`).join('\n')}

Based on this market data, please provide a detailed justification or challenge of the proposed value.

In your analysis:
1. Start with a clear summary of the most comparable auction results, citing specific lot titles, sale dates, and auction houses. Make sure to include the exact lot titles so readers can verify the sales.
2. Compare the proposed value of ${value} ${allResults[0]?.data[0]?.currency || 'USD'} to these actual sales
3. Note any significant condition, quality, or feature differences that might affect the value
4. If relevant, mention any price trends visible in the data (e.g., changes over time or by region)
5. Conclude with a clear statement supporting or challenging the proposed value based on the auction evidence

Keep your response focused and concise, always referencing specific auction results with their exact lot titles and sale information to support your conclusions. This allows readers to verify the sales data independently.
`;

    // Get justification from ChatGPT
    const completion = await this.openai.chat.completions.create({
      model: "o3-mini-high", // o3-mini-high is a new model, do not change the model name
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