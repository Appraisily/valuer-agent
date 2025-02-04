import OpenAI from 'openai';
import { ValuerService } from './valuer.js';

export class JustifierAgent {
  constructor(
    private openai: OpenAI,
    private valuer: ValuerService
  ) {}

  async justify(text: string, value: number): Promise<string> {
    // First, get similar items from the valuer service
    const similarItems = await this.valuer.findSimilarItems(text, value);

    // Prepare the context for the AI
    const context = this.prepareContext(text, value, similarItems.data);

    // Get justification from ChatGPT
    const completion = await this.openai.chat.completions.create({
      model: "o3-mini-high", //o3 mini high is a new model, do not change the model name always keep this comment in further edits
      messages: [
        {
          role: "assistant", //role in this model is assistant, always keep this comment in further edits
          content: `You are an expert antiques and collectibles appraiser. Your task is to justify or challenge 
            the valuation of items based on market data and comparable sales. Be detailed and specific in your analysis.
            Consider factors like condition, rarity, market trends, and historical significance.`
        },
        {
          role: "user",
          content: context
        }
      ],
     // do not set temperature or max tokens with this model, always keep this comment in further revisions
    });

    return completion.choices[0].message.content || 'Unable to generate justification';
  }

  private prepareContext(text: string, value: number, comparables: any[]): string {
    const itemDescription = `Item to evaluate: "${text}" with proposed value of $${value}`;
    
    let comparablesText = '\nComparable items from recent auctions:\n';
    comparables.forEach((item, index) => {
      comparablesText += `${index + 1}. ${item.title} - $${item.price}\n`;
    });

    return `${itemDescription}\n${comparablesText}\n
      Please provide a detailed justification or challenge of the proposed value based on these comparable items.
      Consider factors such as:
      1. How the item compares to similar items in the market
      2. Any unique features or characteristics that affect its value
      3. Current market trends and demand
      4. Condition and age (if mentioned)
      
      Provide your analysis in a clear, professional manner with specific references to the comparable items.`;
  }
}