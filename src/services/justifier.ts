import OpenAI from 'openai';
import { ValuerService } from './valuer.js';

interface MarketDataResult {
  query: string;
  data: any;
  relevance?: string;
}

export class JustifierAgent {
  constructor(
    private openai: OpenAI,
    private valuer: ValuerService
  ) {}

  private async getSearchStrategy(text: string, value: number): Promise<string[]> {
    const prompt = `
As an antiques expert, analyze this item and suggest 3 search queries to find comparable auction items, 
from broad to specific. The goal is to find relevant auction results while ensuring we get enough data 
for comparison (ideally 50-400 results per search).

Item: "${text}" (Estimated value: $${value})

Format your response as a JSON array of 3 strings, from broad to specific. Example:
["furniture", "antique chair", "Victorian mahogany chair"]`;

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
    
    const searchTerms = await this.getSearchStrategy(text, value);
    const allResults: MarketDataResult[] = [];
    
    // Execute all searches to get a comprehensive view
    for (const query of searchTerms) {
      console.log('Trying search term:', query);
      try {
        const result = await this.valuer.findSimilarItems(query, value);
        const resultCount = result.data?.length || 0;
        console.log(`Search "${query}" returned ${resultCount} results`);
        
        allResults.push({ 
          query, 
          data: result,
          relevance: resultCount > 0 && resultCount <= 400 ? 'high' : 
                    resultCount > 400 ? 'broad' : 'limited'
        });
      } catch (error) {
        console.warn(`Search failed for term "${query}":`, error);
        continue;
      }
    }

    // Prepare the prompt with all market data attempts
    const prompt = `
Item to evaluate: "${text}" with proposed value of $${value}

I performed multiple market searches to find comparable items:

${allResults.map((result, index) => `
Search ${index + 1} using term "${result.query}":
${JSON.stringify(result.data, null, 2)}
`).join('\n')}

Based on this market data, please provide a detailed justification or challenge of the proposed value.
Consider:
1. How the item's value compares to similar items in the market data
2. The progression from broad to specific searches (${searchTerms.join(' → ')})
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