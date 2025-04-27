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

Create a JSON array of search query strings (exactly 25 queries) at different specificity levels as follows:
1. Very specific queries (5 queries, 5-6+ words) exactly matching the item description.
2. Specific queries (10 queries, 3-4 words) focusing on key identifying features.
3. Moderate queries (5 queries, 2 words) capturing the item category and main characteristic.
4. Broad queries (5 queries, 1 word) for the general category.

Ensure exactly 5 very specific, 10 specific, 5 moderate, and 5 broad queries are returned in that order.
Response MUST be only a valid JSON array of strings.

Example response format for "Antique Meissen Porcelain Tea Set with Floral Design, circa 1880":
[
  // 5 Very specific queries (5-6+ words)
  "Antique Meissen Porcelain Tea Set Floral 1880",
  "Meissen Porcelain Tea Set Floral Design",
  "Antique Meissen Tea Set Floral 1880",
  "Meissen Porcelain Floral Tea Set 1880",
  "Antique 1880 Meissen Porcelain Tea Set",
  
  // 10 Specific queries (3-4 words)
  "Meissen Porcelain Tea",
  "Meissen Floral Set",
  "Antique Meissen Porcelain",
  "Porcelain Tea Set",
  "Meissen Tea Set",
  "Antique Tea Set",
  "Floral Porcelain Set",
  "Meissen Floral Porcelain",
  "Antique Porcelain 1880",
  "Porcelain Floral Design",
  
  // 5 Moderate queries (2 words)
  "Meissen Porcelain",
  "Antique Porcelain",
  "Tea Set",
  "Floral Porcelain",
  "Antique Meissen",
  
  // 5 Broad queries (1 word)
  "Meissen",
  "Porcelain",
  "Antique",
  "Tea",
  "Floral"
]`;

    try {
        // Use a more capable model for potentially better query generation
        const keywords = await callOpenAIAndParseJson<string[]>(this.openai, {
            model: "gpt-4o", 
            systemMessage: "You are an expert in auction terminology, art, antiques, and collectibles categorization. Generate optimal search queries for finding comparable auction items, returning ONLY a valid JSON array of strings with exactly 5 very specific, 10 specific, 5 moderate, and 5 broad queries.",
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

        // Enforce the structured distribution even if AI doesn't follow instructions perfectly
        const structuredKeywords = this.enforceKeywordStructure(keywords);

        // Log the structured queries by specificity level
        this.logKeywordsBySpecificity(structuredKeywords);

        return structuredKeywords;

    } catch (error) {
      console.error('Error extracting keywords with AI:', error);
      // Fallback strategy if AI fails
      return this.generateFallbackKeywords(text);
    }
  }

  /**
   * Enforces the required distribution of keywords by specificity
   * @param keywords Array of keywords returned by AI
   * @returns Structured array with exactly 5 very specific, 10 specific, 5 moderate, and 5 broad queries
   */
  private enforceKeywordStructure(keywords: string[]): string[] {
    // Group keywords by word count
    const verySpecific: string[] = [];
    const specific: string[] = [];
    const moderate: string[] = [];
    const broad: string[] = [];
    
    // Sort all keywords into appropriate categories
    for (const keyword of keywords) {
      const wordCount = keyword.split(' ').length;
      
      if (wordCount >= 5) {
        verySpecific.push(keyword);
      } else if (wordCount >= 3 && wordCount <= 4) {
        specific.push(keyword);
      } else if (wordCount === 2) {
        moderate.push(keyword);
      } else if (wordCount === 1) {
        broad.push(keyword);
      }
    }
    
    // Select required number from each category, or generate if insufficient
    const result: string[] = [
      ...this.ensureCategoryCount(verySpecific, 5, 5), 
      ...this.ensureCategoryCount(specific, 10, 3),
      ...this.ensureCategoryCount(moderate, 5, 2),
      ...this.ensureCategoryCount(broad, 5, 1)
    ];
    
    return result;
  }
  
  /**
   * Ensures each category has the required number of items
   * @param items Current items in the category
   * @param requiredCount Number of items required
   * @param targetWordCount Target word count for this category
   * @returns Array with exactly requiredCount items
   */
  private ensureCategoryCount(items: string[], requiredCount: number, targetWordCount: number): string[] {
    // If we have more than needed, take the first requiredCount
    if (items.length >= requiredCount) {
      return items.slice(0, requiredCount);
    }
    
    // If we have fewer than needed, fill with generic placeholders
    const result = [...items];
    const shortfall = requiredCount - items.length;
    
    for (let i = 0; i < shortfall; i++) {
      result.push(`Category ${targetWordCount} term ${i+1}`);
    }
    
    return result;
  }

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