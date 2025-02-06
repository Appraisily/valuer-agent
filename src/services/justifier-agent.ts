import OpenAI from 'openai';
import { ValuerService } from './valuer.js';
import { MarketDataService } from './market-data.js';
import { ValueResponse } from './types.js';
import { createSearchStrategyPrompt, createJustificationPrompt, createValueFinderPrompt } from './prompts/index.js';

export class JustifierAgent {
  private marketData: MarketDataService;

  constructor(private openai: OpenAI, valuer: ValuerService) {
    this.marketData = new MarketDataService(valuer);
  }

  private async getSearchStrategy(text: string, value?: number): Promise<string[]> {
    const prompt = createSearchStrategyPrompt(text, value || 250);

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

  async findValueRange(text: string): Promise<ValueRangeResponse> {
    console.log('Finding value range for:', text);
    
    const allSearchTerms = await this.getSearchStrategy(text);
    const allResults = await this.marketData.searchMarketData(allSearchTerms, 1000); // Using a higher base value for broader search

    const completion = await this.openai.chat.completions.create({
      model: "o3-mini",
      messages: [
        {
          role: "assistant",
          content: "You are an expert antiques and collectibles appraiser. Calculate broad value ranges based on auction data, accounting for all possible variations and market conditions."
        },
        {
          role: "user",
          content: createValueRangeFinderPrompt(text, allResults)
        }
      ]
    });

    try {
      const response = JSON.parse(completion.choices[0].message.content || '{}');
      
      // Validate that the range has at least 250% difference
      const minValue = response.minValue || 0;
      const maxValue = response.maxValue || 0;
      const mostLikelyValue = response.mostLikelyValue || 0;
      
      if (maxValue < minValue * 3.5) { // Ensuring at least 250% difference
        const midPoint = (maxValue + minValue) / 2;
        return {
          minValue: Math.floor(midPoint / 2.5),
          maxValue: Math.ceil(midPoint * 2.5),
          mostLikelyValue: Math.round(midPoint),
          explanation: response.explanation || 'Unable to generate explanation'
        };
      }
      
      return {
        minValue,
        maxValue,
        mostLikelyValue,
        explanation: response.explanation || 'Unable to generate explanation'
      };
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      throw new Error('Failed to calculate value range');
    }
  }
  async justify(text: string, value: number): Promise<string> {
    console.log('Justifying valuation for:', { text, value });
    
    const allSearchTerms = await this.getSearchStrategy(text, value);
    const allResults = await this.marketData.searchMarketData(allSearchTerms, value);

    const completion = await this.openai.chat.completions.create({
      model: "o3-mini",
      messages: [
        {
          role: "assistant",
          content: "You are an expert antiques and collectibles appraiser. Analyze market data to justify or challenge valuations. When exact matches are scarce, use your expertise to draw insights from broader market patterns and explain your reasoning clearly."
        },
        {
          role: "user",
          content: createJustificationPrompt(text, value, allResults)
        }
      ]
    });

    return completion.choices[0].message.content || 'Unable to generate justification';
  }

  async findValue(text: string): Promise<ValueResponse> {
    console.log('Finding value for:', text);
    
    const allSearchTerms = await this.getSearchStrategy(text);
    const allResults = await this.marketData.searchMarketData(allSearchTerms, 250);

    const completion = await this.openai.chat.completions.create({
      model: "o3-mini",
      messages: [
        {
          role: "assistant",
          content: "You are an expert antiques and collectibles appraiser. Calculate precise market values based on auction data and explain your reasoning clearly."
        },
        {
          role: "user",
          content: createValueFinderPrompt(text, allResults)
        }
      ]
    });

    try {
      const response = JSON.parse(completion.choices[0].message.content || '{}');
      return {
        value: response.calculatedValue || 0,
        explanation: response.explanation || 'Unable to generate explanation'
      };
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      throw new Error('Failed to calculate value');
    }
  }
}