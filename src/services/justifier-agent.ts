import { ValuerService } from './valuer.js';
import { MarketDataService } from './market-data.js';
import { ValueResponse, ValueRangeResponse, JustifyResponse, MarketDataResult, AuctionItemWithRelevance } from './types.js';
import { createSearchStrategyPrompt, createJustificationPrompt, createValueFinderPrompt, createValueRangeFinderPrompt } from './prompts/index.js';
import { createAccurateValueRangePrompt, createKeywordExtractionPrompt } from './prompts/accurate.js';
import OpenAI from 'openai';
import { callOpenAIAndParseJson } from './utils/openai-helper.js';

// Define interfaces for the expected JSON structures from AI calls
interface KeywordExtractionResponse {
  primaryKeywords: string[];
  secondaryKeywords: string[];
  categoryTerms: string[];
}

interface ValueRangeAIResponse {
  minValue: number;
  maxValue: number;
  mostLikelyValue: number;
  explanation: string;
  auctionResults?: AuctionItemWithRelevance[];
  confidenceLevel?: number;
  marketTrend?: 'rising' | 'stable' | 'declining';
  keyFactors?: string[];
  dataQuality?: 'high' | 'medium' | 'low';
}

interface JustificationAIResponse {
    explanation: string;
    auctionResults?: AuctionItemWithRelevance[]; // Assuming justification might also return this
}

interface ValueFinderAIResponse {
    calculatedValue: number;
    explanation: string;
}

export class JustifierAgent {
  private marketDataService: MarketDataService;

  constructor(private openai: OpenAI, valuer: ValuerService) {
    this.marketDataService = new MarketDataService(valuer);
  }

  // Consolidated method for getting search terms, choosing strategy internally
  private async getSearchTerms(text: string, value?: number, useAccurateModel: boolean = false): Promise<string[]> {
    if (useAccurateModel) {
      return this.extractKeywordsForAccurateSearch(text);
    }
    return this.generateStandardSearchStrategy(text, value);
  }

  // Renamed from getSearchStrategy to be more specific
  private async generateStandardSearchStrategy(text: string, value?: number): Promise<string[]> {
    const prompt = createSearchStrategyPrompt(text, value || 250);
    try {
      const response = await callOpenAIAndParseJson<string[]>(this.openai, {
        model: "o3-mini",
        systemMessage: "You are an expert in antiques and auctions. Your task is to create effective search queries as a JSON array of strings that will find relevant comparable items in auction databases.",
        userPrompt: prompt
      });
      console.log('\n=== AI Standard Search Strategy ===\nGenerated queries:', 
        response.slice(0, 10).map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')
      );
      return Array.isArray(response) ? response : [text];
    } catch (error) {
      console.warn('Failed to get standard search strategy from AI, falling back to text:', error);
      return [text];
    }
  }

  // Renamed from extractKeywords
  private async extractKeywordsForAccurateSearch(text: string): Promise<string[]> {
    console.log('Extracting optimized keywords for accurate auction searches:', text.substring(0, 100) + '...');
    const prompt = createKeywordExtractionPrompt(text);
    try {
      const keywordData = await callOpenAIAndParseJson<KeywordExtractionResponse>(this.openai, {
        model: "o3-mini", // Keep o3-mini for keyword extraction speed?
        systemMessage: "You are an expert in auction terminology and search optimization. Extract precise keywords that would appear in auction catalogs. Return a JSON object with keys 'primaryKeywords', 'secondaryKeywords', 'categoryTerms', each containing an array of strings.",
        userPrompt: prompt
      });

      const primaryKeywords = keywordData.primaryKeywords || [];
      const secondaryKeywords = keywordData.secondaryKeywords || [];
      const categoryTerms = keywordData.categoryTerms || [];

      console.log('\n=== Extracted Accurate Auction Keywords ===');
      console.log('Primary keywords:', primaryKeywords.join(', '));
      console.log('Secondary keywords:', secondaryKeywords.join(', '));
      console.log('Category terms:', categoryTerms.join(', '));

      const searchQueries = [
        ...primaryKeywords,
        ...primaryKeywords.flatMap((primary: string) =>
          secondaryKeywords.slice(0, 3).map((secondary: string) => `${primary} ${secondary}`)
        ),
        ...primaryKeywords.flatMap((primary: string) =>
          categoryTerms.map((category: string) => `${primary} ${category}`)
        )
      ];

      const uniqueQueries = [...new Set(searchQueries)].slice(0, 15);
      console.log('Generated accurate search queries:', 
        uniqueQueries.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')
      );
      return uniqueQueries.length > 0 ? uniqueQueries : [text]; // Ensure fallback

    } catch (error) {
      console.warn('Failed to get accurate keywords from AI, falling back to text:', error);
      return [text];
    }
  }

  // --- Refactored findValueRange --- 

  async findValueRange(text: string, useAccurateModel: boolean = false): Promise<ValueRangeResponse> {
    console.log(`Finding value range for "${text.substring(0,100)}..." (using ${useAccurateModel ? 'accurate' : 'standard'} model)`);
    
    // 1. Get appropriate search terms
    const allSearchTerms = await this.getSearchTerms(text, undefined, useAccurateModel);

    // 2. Search market data
    const minRelevance = useAccurateModel ? 0.7 : 0.5; // Higher relevance for accurate
    const allResults = await this.marketDataService.searchMarketData(allSearchTerms, undefined, false, minRelevance);
    this.logMarketDataSummary(allResults);

    // 3. Call the appropriate AI model for range estimation
    let aiResponse: ValueRangeAIResponse;
    if (useAccurateModel) {
        aiResponse = await this.callAccurateValueRangeAI(text, allResults);
    } else {
        aiResponse = await this.callStandardValueRangeAI(text, allResults);
    }

    // 4. Process and adjust the response
    return this.processValueRangeResponse(aiResponse, useAccurateModel);
  }

  private logMarketDataSummary(allResults: MarketDataResult[]): void {
      console.log('\n=== Market Data Summary ===');
      console.log('Total search results groups:', allResults.length);
      console.log('Results per search term:');
      let totalItems = 0;
      allResults.forEach(result => {
          console.log(`- "${result.query}": ${result.data.length} items`);
          totalItems += result.data.length;
      });
      console.log('Total items found across all searches:', totalItems);
  }

  private async callStandardValueRangeAI(text: string, marketData: MarketDataResult[]): Promise<ValueRangeAIResponse> {
    const prompt = createValueRangeFinderPrompt(text, marketData);
    const systemMessage = "You are an expert antiques and collectibles appraiser. Calculate broad value ranges based on auction data, accounting for all possible variations and market conditions. Respond with a JSON object including keys: 'minValue', 'maxValue', 'mostLikelyValue', 'explanation', 'auctionResults', 'confidenceLevel', 'marketTrend', 'keyFactors', 'dataQuality'.";
    
    return await callOpenAIAndParseJson<ValueRangeAIResponse>(this.openai, {
      model: "o3-mini",
      systemMessage: systemMessage,
      userPrompt: prompt
    });
  }

  private async callAccurateValueRangeAI(text: string, marketData: MarketDataResult[]): Promise<ValueRangeAIResponse> {
    const prompt = createAccurateValueRangePrompt(text, marketData);
    const systemMessage = "You are an expert art and antiques appraiser specializing in precise market valuations. Provide accurate value ranges based on verified auction data, focusing on current market reality. Respond with a JSON object including keys: 'minValue', 'maxValue', 'mostLikelyValue', 'explanation', 'auctionResults', 'confidenceLevel', 'marketTrend', 'keyFactors', 'dataQuality'.";

    return await callOpenAIAndParseJson<ValueRangeAIResponse>(this.openai, {
      model: "gpt-4o", // Use more capable model for accuracy
      systemMessage: systemMessage,
      userPrompt: prompt
    });
  }

  private processValueRangeResponse(response: ValueRangeAIResponse, useAccurateModel: boolean): ValueRangeResponse {
      let { 
          minValue = 0, 
          maxValue = 0, 
          mostLikelyValue = 0, 
          explanation = 'Unable to generate explanation', 
          auctionResults = [], 
          confidenceLevel = 70, 
          marketTrend = 'stable', 
          keyFactors = [], 
          dataQuality = 'medium'
      } = response;

      // Post-processing adjustments (consider removing/refining these based on the report)
      if (!useAccurateModel && maxValue > 0 && minValue >= 0 && maxValue < minValue * 4.5) { // Standard model range expansion
          console.warn('Standard model range is narrow, applying artificial expansion...');
          const midPoint = (maxValue + minValue) / 2;
          minValue = Math.max(0, Math.floor(midPoint / 3.25)); // Ensure min is not negative
          maxValue = Math.ceil(midPoint * 3.25);
          mostLikelyValue = Math.round(midPoint);
      } else if (useAccurateModel) { // Accurate model sanity checks
          if (mostLikelyValue > 0 && minValue > mostLikelyValue) {
              console.warn('Accurate model: Adjusting minValue to be <= mostLikelyValue');
              minValue = Math.floor(mostLikelyValue * 0.85);
          }
          if (mostLikelyValue > 0 && maxValue < mostLikelyValue) {
              console.warn('Accurate model: Adjusting maxValue to be >= mostLikelyValue');
              maxValue = Math.ceil(mostLikelyValue * 1.15);
          }
          // Ensure min <= mostLikely <= max
          if (minValue > maxValue) {
             console.warn('Accurate model: minValue > maxValue after adjustments, swapping.');
             [minValue, maxValue] = [maxValue, minValue]; 
          }
          if (mostLikelyValue < minValue) mostLikelyValue = minValue;
          if (mostLikelyValue > maxValue) mostLikelyValue = maxValue;
      }
      
      // Ensure min/max/mostLikely are non-negative integers
      minValue = Math.max(0, Math.round(minValue));
      maxValue = Math.max(0, Math.round(maxValue));
      mostLikelyValue = Math.max(minValue, Math.round(mostLikelyValue)); // Ensure mostLikely >= minValue
      mostLikelyValue = Math.min(maxValue, mostLikelyValue); // Ensure mostLikely <= maxValue

      return {
          minValue,
          maxValue,
          mostLikelyValue,
          explanation,
          auctionResults,
          confidenceLevel,
          marketTrend,
          keyFactors,
          dataQuality
      };
  }

  // --- End Refactored findValueRange ---

  async justify(text: string, value: number): Promise<JustifyResponse> {
    console.log('Justifying valuation for:', { text, value });

    const allSearchTerms = await this.getSearchTerms(text, value); // Default to standard search
    const allResults = await this.marketDataService.searchMarketData(allSearchTerms, value, true); // isForJustification = true
    this.logMarketDataSummary(allResults);

    const prompt = createJustificationPrompt(text, value, allResults);
    const systemMessage = "You are an expert antiques and collectibles appraiser. Analyze market data to justify or challenge valuations. Respond with a JSON object including 'explanation' and optional 'auctionResults'.";

    try {
        const response = await callOpenAIAndParseJson<JustificationAIResponse>(this.openai, {
            model: "o3-mini",
            systemMessage: systemMessage,
            userPrompt: prompt
        });
        return {
            explanation: response.explanation || 'Unable to generate explanation',
            auctionResults: response.auctionResults || [],
            allSearchResults: allResults // Include raw search data
        };
    } catch (error) {
        console.error('Failed to generate justification:', error);
        // Provide a fallback response or rethrow depending on desired behavior
        throw new Error('Failed to generate justification due to AI processing error.');
    }
  }

  async findValue(text: string): Promise<ValueResponse> {
    console.log('Finding value for:', text.substring(0, 100) + '...');

    const allSearchTerms = await this.getSearchTerms(text); // Default to standard search
    const allResults = await this.marketDataService.searchMarketData(allSearchTerms, undefined, false);
    this.logMarketDataSummary(allResults);

    const prompt = createValueFinderPrompt(text, allResults);
    const systemMessage = "You are an expert antiques and collectibles appraiser. Calculate precise market values based on auction data. Respond with a JSON object including 'calculatedValue' and 'explanation'.";

    try {
        const response = await callOpenAIAndParseJson<ValueFinderAIResponse>(this.openai, {
            model: "o3-mini",
            systemMessage: systemMessage,
            userPrompt: prompt
        });
        return {
            value: response.calculatedValue || 0,
            explanation: response.explanation || 'Unable to generate explanation'
        };
     } catch (error) {
        console.error('Failed to calculate value:', error);
        throw new Error('Failed to calculate value due to AI processing error.');
    }
  }
}