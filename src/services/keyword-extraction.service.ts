import OpenAI from 'openai';
import { callOpenAIAndParseJson } from './utils/openai-helper.js';

export class KeywordExtractionService {
  constructor(private openai: OpenAI) {}

  /**
   * Extracts optimal search keywords for finding similar items using an AI prompt.
   * @param text Description of the item.
   * @returns Array of search terms from most specific to most general.
   */
  async extractKeywords(text: string): Promise<string[]> {
    console.log('Extracting optimized keywords for statistics:', text.substring(0, 100) + '...');

    // Enhanced prompt with structured distribution requirements
    const prompt = `
Generate multiple levels of search queries for finding comparable auction items for:
"${text}"

Create a JSON object with the following structure:
{
  "result": [
    // 5 Very specific queries (exact phrases that might match the item description)
    // 10 Specific queries (key identifying features)
    // 5 Moderate queries (category and main characteristic)
    // 5 Broad queries (general category)
  ]
}

IMPORTANT: 
- Each keyword or phrase should be an actual auction search term
- Avoid hyphenated terms like "Impressionist-Style" - use separate words instead (e.g., "Impressionist Style")
- When referencing art styles, artists, materials, etc., use common terminology found in auction catalogs
- Return ONLY a valid JSON object with the exact structure shown above - no explanation or additional text

Example response format for "Salvador Dali Impressionist Rural Landscape":
{
  "result": [
    "Salvador Dali Impressionist Rural Landscape Painting",
    "Dali Impressionist Style Landscape Art Piece",
    "Salvador Dali Impressionist Landscape Drawing",
    "Dali Rural Landscape Impressionist Painting",
    "Salvador Dali Impressionist Style Rural Artwork",
    "Salvador Dali Impressionist",
    "Dali Rural Landscape",
    "Impressionist Rural Art",
    "Dali Impressionist Art",
    "Rural Landscape Art",
    "Impressionist Salvador Dali",
    "Impressionist Style Painting",
    "Dali Landscape Painting",
    "Rural Landscape Painting",
    "Dali Impressionist Drawing",
    "Dali Impressionist",
    "Rural Landscape",
    "Impressionist Art",
    "Landscape Painting",
    "Dali Art",
    "Impressionist",
    "Landscape",
    "Salvador",
    "Dali",
    "Art"
  ]
}`;

    try {
        // Use a more capable model for better query generation
        const response = await callOpenAIAndParseJson<{result: string[]}>(this.openai, {
            model: "gpt-4o", 
            systemMessage: "You are an expert in auction terminology, art, antiques, and collectibles categorization. Generate optimal search queries for finding comparable auction items, returning ONLY a valid JSON object with the exact structure requested.",
            userPrompt: prompt,
            expectJsonResponse: true
        });

        if (!response || !response.result || !Array.isArray(response.result) || response.result.length === 0) {
          throw new Error('Invalid or empty keyword array returned by AI');
        }

        // Ensure we have exactly 25 keywords
        let keywords = response.result;
        if (keywords.length > 25) {
          keywords = keywords.slice(0, 25);
        } else if (keywords.length < 25) {
          const shortfall = 25 - keywords.length;
          for (let i = 0; i < shortfall; i++) {
            keywords.push(`Keyword ${keywords.length + 1}`);
          }
        }

        // Log the structured queries by specificity level
        this.logKeywordsBySpecificity(keywords);

        return keywords;

    } catch (error) {
      console.error('Error extracting keywords with AI:', error);
      // Fallback strategy if AI fails
      return this.generateFallbackKeywords(text);
    }
  }

  /**
   * Logs the extracted keywords organized by specificity level
   */
  private logKeywordsBySpecificity(keywords: string[]): void {
    console.log('Extracted search queries by specificity:');
    // Based on our enforced structure, we know exactly where each category begins and ends
    const verySpecific = keywords.slice(0, 5);
    const specific = keywords.slice(5, 15);
    const moderate = keywords.slice(15, 20);
    const broad = keywords.slice(20, 25);
    
    console.log(`- Very specific (${verySpecific.length}): ${verySpecific.join(', ')}`);
    console.log(`- Specific (${specific.length}): ${specific.join(', ')}`);
    console.log(`- Moderate (${moderate.length}): ${moderate.join(', ')}`);
    console.log(`- Broad (${broad.length}): ${broad.join(', ')}`);
  }

  private generateFallbackKeywords(text: string): string[] {
    console.warn('Using fallback keyword generation strategy.');
    const words = text.split(' ');
    
    // Generate fallbacks in the same structured format (5-10-5-5)
    const result: string[] = [];
    
    // 5 very specific
    result.push(text); // Original text
    result.push(words.slice(0, 6).join(' ')); // First 6 words
    result.push(words.slice(0, 5).join(' ')); // First 5 words
    result.push(words.slice(words.length > 6 ? words.length - 6 : 0).join(' ')); // Last 6 words
    result.push(words.slice(0, 3).concat(words.slice(words.length - 2)).join(' ')); // Mix of first and last
    
    // 10 specific
    for (let i = 0; i < 10; i++) {
      const start = i % words.length;
      const end = Math.min(start + 3, words.length);
      result.push(words.slice(start, end).join(' '));
    }
    
    // 5 moderate
    for (let i = 0; i < 5; i++) {
      const start = i % words.length;
      result.push(words.slice(start, start + Math.min(2, words.length - start)).join(' '));
    }
    
    // 5 broad
    for (let i = 0; i < 5 && i < words.length; i++) {
      result.push(words[i]);
    }
    
    console.log('Using fallback keywords with structured format');
    return result;
  }
} 