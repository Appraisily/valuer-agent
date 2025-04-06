import OpenAI from 'openai';
import { callOpenAIAndParseJson } from './utils/openai-helper.js';

// Interface for the expected response structure from the keyword extraction prompt
interface KeywordResponse {
  // Assuming the prompt asks for a flat array of strings
  keywords: string[];
}

export class KeywordExtractionService {
  constructor(private openai: OpenAI) {}

  /**
   * Extracts optimal search keywords for finding similar items using an AI prompt.
   * @param text Description of the item.
   * @returns Array of search terms from most specific to most general.
   */
  async extractKeywords(text: string): Promise<string[]> {
    console.log('Extracting optimized keywords for statistics:', text.substring(0, 100) + '...');

    // Enhanced prompt for more comprehensive search query generation
    const prompt = `
Generate multiple levels of search queries for finding comparable auction items for:
"${text}"

Create a JSON array of search query strings (10-15 queries) at different specificity levels, ordered from most specific to most general:
1. Very specific queries (5-6 words) exactly matching the item description.
2. Specific queries (3-4 words) focusing on key identifying features.
3. Moderate queries (2-3 words) capturing the item category and main characteristic.
4. Broad queries (1-2 words) for the general category.

The goal is to ensure sufficient auction data can be found even for rare items.
Response MUST be only a valid JSON array of strings.

Example response format for "Antique Meissen Porcelain Tea Set with Floral Design, circa 1880":
[
  "Antique Meissen Porcelain Tea Set Floral 1880",
  "Meissen Porcelain Tea Set Floral",
  "Meissen Porcelain Tea Set",
  "Antique Meissen Porcelain 1880",
  "Meissen Porcelain Floral",
  "Antique Tea Set 1880",
  "Meissen Porcelain",
  "Antique Tea Set", 
  "Porcelain Tea Set",
  "Meissen Tea",
  "Antique Porcelain",
  "Tea Set",
  "Porcelain",
  "Meissen"
]`;

    try {
        // Use a more capable model for potentially better query generation
        const keywords = await callOpenAIAndParseJson<string[]>(this.openai, {
            model: "gpt-4o", 
            systemMessage: "You are an expert in auction terminology, art, antiques, and collectibles categorization. Generate optimal search queries for finding comparable auction items, returning ONLY a valid JSON array of strings ordered by specificity.",
            userPrompt: prompt
        },
        // Add a parser function to handle potential markdown code blocks around the JSON array
        (content) => {
            const jsonMatch = content.match(/\`\`\`json\n?(\[.*\])\n?\`\`\`/s) || content.match(/(\[.*\])/s);
            return jsonMatch ? jsonMatch[1] : content;
        });

        if (!Array.isArray(keywords) || keywords.length === 0) {
          throw new Error('Invalid or empty keyword array returned by AI');
        }

        // Log the structured queries by specificity level (for debugging/monitoring)
        this.logKeywordsBySpecificity(keywords);

        return keywords;

    } catch (error) {
      console.error('Error extracting keywords with AI:', error);
      // Fallback strategy if AI fails
      return this.generateFallbackKeywords(text);
    }
  }

  private logKeywordsBySpecificity(keywords: string[]): void {
      console.log('Extracted search queries by specificity:');
      const verySpecific = keywords.filter((k: string) => k.split(' ').length >= 5);
      const specific = keywords.filter((k: string) => k.split(' ').length >= 3 && k.split(' ').length < 5);
      const moderate = keywords.filter((k: string) => k.split(' ').length === 2);
      const broad = keywords.filter((k: string) => k.split(' ').length === 1);
      
      console.log(`- Very specific (${verySpecific.length}): ${verySpecific.join(', ')}`);
      console.log(`- Specific (${specific.length}): ${specific.join(', ')}`);
      console.log(`- Moderate (${moderate.length}): ${moderate.join(', ')}`);
      console.log(`- Broad (${broad.length}): ${broad.join(', ')}`);
  }

  private generateFallbackKeywords(text: string): string[] {
      console.warn('Using fallback keyword generation strategy.');
      const words = text.split(' ');
      const fallbackKeywords = [
        text, // Original text
        words.slice(0, 4).join(' '), // First 4 words
        words.slice(0, 2).join(' '), // First 2 words
        words.length > 1 ? words[1] : words[0], // Second word or first if only one
        words[0] // First word
      ].filter((kw, index, self) => kw && self.indexOf(kw) === index); // Filter empty and duplicates
      
      console.log('Using fallback keywords:', fallbackKeywords.join(', '));
      return fallbackKeywords;
  }
} 