import OpenAI from 'openai';
import { ValuerService } from './valuer';
import { MarketDataService } from './market-data';
import { ValueResponse, ValueRangeResponse } from './types';
import { createSearchStrategyPrompt, createJustificationPrompt, createValueFinderPrompt, createValueRangeFinderPrompt } from './prompts';

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
      const content = completion.choices[0]?.message?.content;
      if (!content) return [text];
      
      const queries = JSON.parse(content);
      console.log('\n=== AI Search Strategy ===\nGenerated queries:', 
        queries.slice(0, 10).map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')
      );
      return Array.isArray(queries) ? queries : [text];
    } catch (error) {
      console.warn('Failed to parse AI search queries:', error);
      return [text];
    }
  }

  async findValueRange(text: string): Promise<ValueRangeResponse> {
    console.log('Finding value range for:', text);
    
    const allSearchTerms = await this.getSearchStrategy(text);
    const allResults = await this.marketData.searchMarketData(allSearchTerms, 1000);

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
      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }
      
      const response = JSON.parse(content);
      
      const minValue = response.minValue || 0;
      const maxValue = response.maxValue || 0;
      const mostLikelyValue = response.mostLikelyValue || 0;
      
      if (maxValue < minValue * 3.5) {
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

    return completion.choices[0]?.message?.content || 'Unable to generate justification';
  }

  async findValue(text: string): Promise<ValueResponse> {
    console.log('Finding value for:', text);
    
    const allSearchTerms = await this.getSearchStrategy(text);
    const allResults = await this.marketData.searchMarketData(allSearchTerms, 250);

    console.log('\n=== Final Prompt to GPT ===\nFirst 10 lines:',
      createValueFinderPrompt(text, allResults)
        .split('\n')
        .slice(0, 10)
        .join('\n')
    );

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
      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }
      
      const response = JSON.parse(content);
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