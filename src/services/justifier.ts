import OpenAI from 'openai';
import { ValuerService } from './valuer.js';

interface MarketDataResult {
  query: string;
  data: any;
}

export class JustifierAgent {
  constructor(
    private openai: OpenAI,
    private valuer: ValuerService
  ) {}

  private getBroaderTerms(text: string): string[] {
    // Remove specific details to create broader search terms
    const terms = text.toLowerCase()
      .replace(/circa \d+/g, '') // Remove circa dates
      .replace(/\d+s?/g, '')     // Remove years
      .split(',')[0]             // Take first part before any comma
      .split(' ')
      .filter(word => 
        word.length > 3 &&       // Skip small words
        !['and', 'with', 'the'].includes(word)
      );

    // Create combinations of key terms
    const results: string[] = [];
    
    // Add original search as first priority
    results.push(text);
    
    // Add category + main material/style if present
    if (terms.length >= 2) {
      results.push(`${terms[0]} ${terms[1]}`);
    }
    
    // Add just the main category
    if (terms.length > 0) {
      results.push(terms[0]);
    }

    return results;
  }

  async justify(text: string, value: number): Promise<string> {
    const searchTerms = this.getBroaderTerms(text);
    const allResults: MarketDataResult[] = [];
    
    // Try up to 3 increasingly broader searches
    for (const query of searchTerms.slice(0, 3)) {
      try {
        const result = await this.valuer.findSimilarItems(query, value);
        allResults.push({ query, data: result });
        
        // If we got some results, we can stop searching
        if (result.data.length > 0) {
          break;
        }
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
2. Any notable price patterns or trends in the comparable items
3. Specific examples from the market data that support or challenge the valuation
4. Any significant price outliers and their potential impact on the valuation
5. The relevance of each search result to the original item

If the market data is limited or not directly comparable, please:
- Explain why finding exact matches might be challenging
- Use the broader market context from similar categories
- Highlight what factors from the original item might justify price differences
- Suggest what additional information would help refine the valuation

Please provide your analysis in a clear, professional manner with specific references to the market data.`;

    // Get justification from ChatGPT
    const completion = await this.openai.chat.completions.create({
      model: "o3-mini-high", //o3 mini high is a new model, do not change the model name
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