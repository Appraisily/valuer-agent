/**
 * Accurate valuation prompts for more precise appraisal insights
 */

import { formatAuctionResults } from './index.js';

export function createAccurateValueRangePrompt(text: string, allResults: any[]): string {
  return `
You are a professional art and antiques appraiser with extensive expertise in auction markets and real-time valuation.

Item to evaluate: "${text}"

Below are verified auction results from reputable auction houses that are relevant to this item:

${formatAuctionResults(allResults)}

Provide a precise market valuation analysis with these requirements:

1. Focus on ACCURACY over breadth: Narrow range based on closest comparable items
2. Use statistical analysis of the auction data - median and mean of most relevant comps
3. Consider recency of sales, giving higher weight to most recent auction results (within last 12 months)
4. Analyze quality/condition factors evident in the item description
5. For "most likely value" - determine the precise current market value based on closest matches, not the middle of the range
6. Apply market trend analysis to adjust for current conditions
7. Factor in rarity, provenance, and condition where evident
8. Identify specific factors that justify your valuation
9. Assess the data quality - are there sufficient close comparables for a confident valuation?
10. Consider any unique features mentioned in the item description and adjust accordingly

Format your response as follows:
{
  "minValue": [precise minimum justifiable value as a number],
  "maxValue": [precise maximum justifiable value as a number],
  "mostLikelyValue": [precise most likely current market value as a number],
  "explanation": [Detailed explanation of your valuation with specific reference points],
  "confidenceLevel": [A percentage (1-100) indicating your confidence in this valuation],
  "marketTrend": ["rising", "stable", or "declining"],
  "keyFactors": [Array of 3-5 key factors influencing this valuation],
  "dataQuality": ["high", "medium", or "low"],
  "auctionResults": [
    {
      "title": [lot title],
      "price": [realized price],
      "currency": [currency code],
      "house": [auction house name],
      "date": [sale date],
      "relevanceScore": [1-10 rating of how relevant this comp is],
      "adjustmentFactor": [the adjustment factor applied relative to the subject item],
      "relevanceReason": [brief explanation of why this result is relevant]
    },
    ... up to 10 results
  ]
}

CRITICAL REQUIREMENTS:
- Prioritize ACCURACY over conservative ranges - provide the most precise real-world valuation possible
- Range should be appropriately narrow for the quality of data available (15-30% difference)
- For high-quality data with close matches, range should be particularly narrow (5-15%)
- Most likely value should be precisely calculated based on statistical analysis, not simply the midpoint
- If auction results show a clear price level for similar items, reflect this in your valuation
- Specify exactly which auction results most influenced your valuation and why
- If your confidence level is below 75%, explain why
- For items with significant historical, artistic, or cultural importance, note this in your explanation
- Include market trend analysis based on sales data chronology
- Calculate most likely value as weighted average of the most relevant comparable sales, with weightings clearly explained
- KEY FACTORS should include material, age, condition, rarity, maker/artist (if known), and market demand
- DATA QUALITY should assess whether there are sufficient close matches for confident valuation

Statistical Analysis Guidelines:
1. Identify the 3-5 most directly comparable items 
2. Calculate median and mean prices of these closest matches
3. Apply appropriate weightings based on relevance and recency
4. For market trend analysis, compare prices over time if date information permits
5. Most likely value should be the weighted average of the most relevant comparables
6. Min/max values should represent realistic market range, not outliers
7. If using a smaller subset of highly relevant comparables, note this in your explanation`;
}

/**
 * Function to extract keywords from item description for optimized auction searches
 */
export function createKeywordExtractionPrompt(text: string): string {
  return `
You are an expert in auction catalogs and art/antiques terminology.

Item description: "${text}"

Extract the most valuable search keywords from this description to find comparable auction results.

Your task:
1. Identify key descriptive terms that would appear in auction catalogs
2. Include manufacturer/artist/maker names, materials, period/era terms, and distinctive features
3. Exclude generic terms that would return too many irrelevant results
4. Organize keywords from most specific to more general

Format your response as:
{
  "primaryKeywords": [array of 3-5 most specific and important search terms],
  "secondaryKeywords": [array of 5-8 additional relevant terms],
  "categoryTerms": [array of 2-3 general category terms],
  "exclusionTerms": [array of terms that should be excluded to avoid irrelevant results]
}

IMPORTANT:
- Focus on terms that auctioneers and appraisers would use in formal catalog descriptions
- Include variations of key terms where relevant (e.g., "Art Deco" and "Art-Deco")
- For artworks, always include artist name and medium
- For furniture, include style, wood type, and period
- For decorative arts, include maker, material, and period
- Return only the JSON object with no additional text`;
}

/**
 * Export functions for use by injecting into the original prompts file
 */
export default {
  createAccurateValueRangePrompt,
  createKeywordExtractionPrompt
}