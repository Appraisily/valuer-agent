import OpenAI from 'openai';
import { ValuerService } from './valuer.js';

export class JustifierAgent {
  constructor(
    private openai: OpenAI,
    private valuer: ValuerService
  ) {}

  async justify(text: string, value: number): Promise<string> {
    // Get raw market data from valuer service
    const marketData = await this.valuer.findSimilarItems(text, value);

    // Prepare the prompt with raw market data
    const prompt = `
Item to evaluate: "${text}" with proposed value of $${value}

Market data from auction database:
${JSON.stringify(marketData, null, 2)}

Based on this market data, please provide a detailed justification or challenge of the proposed value.
Consider:
1. How the item's value compares to similar items in the market data
2. Any notable price patterns or trends in the comparable items
3. Specific examples from the market data that support or challenge the valuation
4. Any significant price outliers and their potential impact on the valuation

Please provide your analysis in a clear, professional manner with specific references to the market data.`;

    // Get justification from ChatGPT
    const completion = await this.openai.chat.completions.create({
      model: "o3-mini-high", //o3 mini high is a new model, do not change the model name
      messages: [
        {
          role: "assistant", //role in this model is assistant
          content: "You are an expert antiques and collectibles appraiser. Analyze market data to justify or challenge valuations."
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