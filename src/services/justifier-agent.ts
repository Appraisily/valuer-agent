import OpenAI from 'openai';
import { ValuerService } from './valuer.js';
import { MarketDataService } from './market-data.js';
import { ValueResponse, ValueRangeResponse, JustifyResponse } from './types.js';
import { createSearchStrategyPrompt, createJustificationPrompt, createValueFinderPrompt, createValueRangeFinderPrompt } from './prompts/index.js';
import { createAccurateValueRangePrompt, createKeywordExtractionPrompt } from './prompts/accurate.js';

export class JustifierAgent {
  private marketData: MarketDataService;

  constructor(private openai: OpenAI, valuer: ValuerService) {
    this.marketData = new MarketDataService(valuer);
  }

  private async getSearchStrategy(text: string, value?: number, useAccurateModel: boolean = false): Promise<string[]> {
    // If using accurate model, use the keyword extraction approach
    if (useAccurateModel) {
      return await this.extractKeywords(text);
    }
    
    // Otherwise use the standard search strategy
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
  
  private async extractKeywords(text: string): Promise<string[]> {
    console.log('Extracting optimized keywords for auction searches:', text.substring(0, 100) + '...');
    
    const prompt = createKeywordExtractionPrompt(text);
    
    const completion = await this.openai.chat.completions.create({
      model: "o3-mini",
      messages: [
        {
          role: "assistant",
          content: "You are an expert in auction terminology and search optimization. Extract precise keywords that would appear in auction catalogs."
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
      
      const keywordData = JSON.parse(content);
      
      // Combine primary and secondary keywords into search queries
      const primaryKeywords = keywordData.primaryKeywords || [];
      const secondaryKeywords = keywordData.secondaryKeywords || [];
      const categoryTerms = keywordData.categoryTerms || [];
      
      console.log('\n=== Extracted Auction Keywords ===');
      console.log('Primary keywords:', primaryKeywords.join(', '));
      console.log('Secondary keywords:', secondaryKeywords.join(', '));
      console.log('Category terms:', categoryTerms.join(', '));
      
      // Create combination search queries
      const searchQueries = [
        // Use the primary keywords as individual searches
        ...primaryKeywords,
        
        // Create combined searches using primary + secondary keywords
        ...primaryKeywords.flatMap(primary => 
          secondaryKeywords.slice(0, 3).map(secondary => `${primary} ${secondary}`)
        ),
        
        // Add broader category searches with primary keywords
        ...primaryKeywords.flatMap(primary => 
          categoryTerms.map(category => `${primary} ${category}`)
        )
      ];
      
      // Limit to a reasonable number of queries and ensure uniqueness
      const uniqueQueries = [...new Set(searchQueries)].slice(0, 15);
      
      console.log('Generated search queries:', 
        uniqueQueries.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')
      );
      
      return uniqueQueries;
    } catch (error) {
      console.warn('Failed to parse keyword extraction response:', error);
      return [text];
    }
  }

  async findValueRange(text: string, useAccurateModel: boolean = false): Promise<ValueRangeResponse> {
    console.log('Finding value range for:', text, `(using ${useAccurateModel ? 'accurate' : 'standard'} model)`);
    
    // Use the keyword extraction for accurate model to get better auction search results
    const allSearchTerms = await this.getSearchStrategy(text, undefined, useAccurateModel);
    
    // For accurate model, we'll set minRelevance threshold higher to get better results
    const minRelevance = useAccurateModel ? 0.7 : 0.5;
    const allResults = await this.marketData.searchMarketData(allSearchTerms, undefined, false, minRelevance);
    
    console.log('\n=== Market Data Summary ===');
    console.log('Total search results:', allResults.length);
    console.log('Results per search term:');
    allResults.forEach(result => {
      console.log(`- "${result.query}": ${result.data.length} items`);
    });

    // Use the appropriate prompt based on the accuracy flag
    const prompt = useAccurateModel 
      ? createAccurateValueRangePrompt(text, allResults)
      : createValueRangeFinderPrompt(text, allResults);
    
    console.log('\n=== Generated Prompt ===\n', prompt.substring(0, 500) + '...');

    // Use the appropriate system message based on the model type
    const systemMessage = useAccurateModel 
      ? "You are an expert art and antiques appraiser specializing in precise market valuations. Your task is to provide accurate value ranges based on verified auction data, focusing on the current market reality rather than broad ranges."
      : "You are an expert antiques and collectibles appraiser. Calculate broad value ranges based on auction data, accounting for all possible variations and market conditions.";

    const completion = await this.openai.chat.completions.create({
      model: useAccurateModel ? "gpt-4o" : "o3-mini", // Use a more capable model for accurate valuations
      messages: [
        {
          role: "system",
          content: systemMessage
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const aiResponse = completion.choices[0]?.message?.content;
    console.log('\n=== OpenAI Raw Response ===\n', aiResponse || 'No content');

    try {
      if (!aiResponse) {
        throw new Error('No response from OpenAI');
      }
      
      const response = JSON.parse(aiResponse);
      console.log('\n=== Parsed Response ===\n', JSON.stringify(response, null, 2));
      
      const minValue = response.minValue || 0;
      const maxValue = response.maxValue || 0;
      const mostLikelyValue = response.mostLikelyValue || 0;
      const auctionResults = response.auctionResults || [];
      const confidenceLevel = response.confidenceLevel || 70;
      const marketTrend = response.marketTrend || 'stable';
      const keyFactors = response.keyFactors || [];
      const dataQuality = response.dataQuality || 'medium';
      
      // Only use the artificial range expansion for the standard model, not the accurate one
      if (!useAccurateModel && maxValue < minValue * 4.5) { // Ensure at least 350% difference for standard model
        const midPoint = (maxValue + minValue) / 2;
        return {
          minValue: Math.floor(midPoint / 3.25),
          maxValue: Math.ceil(midPoint * 3.25),
          mostLikelyValue: Math.round(midPoint),
          explanation: response.explanation || 'Unable to generate explanation',
          auctionResults: auctionResults,
          confidenceLevel,
          marketTrend,
          keyFactors,
          dataQuality
        };
      }
      
      // For accurate model, ensure the range is reasonable but not artificially broad
      if (useAccurateModel) {
        // Validate min and max values
        if (minValue > mostLikelyValue) {
          console.warn('Adjusting minimum value to be less than most likely value');
          const adjustedMin = Math.floor(mostLikelyValue * 0.85);
          return {
            minValue: adjustedMin,
            maxValue,
            mostLikelyValue,
            explanation: response.explanation || 'Unable to generate explanation',
            auctionResults: auctionResults,
            confidenceLevel,
            marketTrend,
            keyFactors,
            dataQuality
          };
        }
        
        if (maxValue < mostLikelyValue) {
          console.warn('Adjusting maximum value to be greater than most likely value');
          const adjustedMax = Math.ceil(mostLikelyValue * 1.15);
          return {
            minValue,
            maxValue: adjustedMax,
            mostLikelyValue,
            explanation: response.explanation || 'Unable to generate explanation',
            auctionResults: auctionResults,
            confidenceLevel,
            marketTrend,
            keyFactors,
            dataQuality
          };
        }
      }
      
      return {
        minValue,
        maxValue,
        mostLikelyValue,
        explanation: response.explanation || 'Unable to generate explanation',
        auctionResults: auctionResults,
        confidenceLevel,
        marketTrend,
        keyFactors,
        dataQuality
      };
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      throw new Error('Failed to calculate value range');
    }
  }

  async justify(text: string, value: number): Promise<JustifyResponse> {
    console.log('Justifying valuation for:', { text, value });
    
    const allSearchTerms = await this.getSearchStrategy(text, value);
    const allResults = await this.marketData.searchMarketData(allSearchTerms, value, true);

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

    try {
      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }
      
      const response = JSON.parse(content);
      return {
        explanation: response.explanation || 'Unable to generate explanation',
        auctionResults: response.auctionResults || [],
        allSearchResults: allResults // Include all search results from all queries
      };
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      throw new Error('Failed to generate justification');
    }
  }

  async findValue(text: string): Promise<ValueResponse> {
    console.log('Finding value for:', text);
    
    const allSearchTerms = await this.getSearchStrategy(text);
    const allResults = await this.marketData.searchMarketData(allSearchTerms, undefined, false);

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