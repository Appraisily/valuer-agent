function formatAuctionResults(results: any[]): string {
  if (!Array.isArray(results) || results.length === 0) {
    return 'No auction results available.';
  }

  return results
    .map(result => {
      const items = result.data
        .map((item: any) => 
          `- ${item.title}\n  Price: ${item.currency} ${item.price}\n  Auction House: ${item.house}\n  Date: ${item.date}\n  ${item.description ? `Description: ${item.description}\n` : ''}`
        )
        .join('\n');
      
      return `Search: "${result.query}"\nRelevance: ${result.relevance || 'unknown'}\n\n${items}`;
    })
    .join('\n\n');
}

export function createSearchStrategyPrompt(text: string, value?: number): string {
  return `
Generate search queries to find comparable items for:
"${text}"${value ? ` (estimated value: ${value})` : ''}

Return an array of search terms, ordered from most specific to most general.
Include variations in terminology and key features.

Example response format:
["exact match query", "variation 1", "broader query", "general category"]
`;
}

export function createJustificationPrompt(text: string, value: number, allResults: any[]): string {
  return `
Analyze if ${value} is a reasonable value for:
"${text}"

Here are relevant auction results for comparison:

${formatAuctionResults(allResults)}

Provide a detailed analysis that:
1. Compares the proposed value to actual sales
2. Identifies key value factors
3. Explains market trends
4. Considers condition and provenance
5. References specific comparable sales
`;
}

export function createValueFinderPrompt(text: string, allResults: any[]): string {
  return `
Calculate a specific market value for:
"${text}"

Based on these auction results:

${formatAuctionResults(allResults)}

Format your response as:
{
  "calculatedValue": [number],
  "explanation": [detailed analysis with specific examples]
}

Your explanation must:
1. Reference at least 3 specific comparable sales
2. Explain value adjustments
3. Consider condition and market factors
4. Justify the final value
`;
}

export function createValueRangeFinderPrompt(text: string, allResults: any[]): string {
  return `
Item to evaluate: "${text}"

Here are the most relevant auction results found for comparison (all auction details are verifiable):

${formatAuctionResults(allResults)}

Based on this market data, provide a comprehensive analysis that includes:

1. Calculate a broad value range for the item that accounts for all possible variations in condition, provenance, and market fluctuations
2. The range should be very wide to account for uncertainty, with at least a 350% difference between minimum and maximum values
3. Also provide a most likely value within this range
4. CRITICAL: Include at least 5 specific auction examples that support your analysis, including:
   - At least one example near the minimum value
   - At least one example near the maximum value
   - At least three examples around the most likely value
   For each example, you MUST include:
   - Exact lot title
   - Auction house name
   - Sale date
   - Realized price
   - Relevant condition or detail notes

Format your response as follows:

{
  "minValue": [minimum possible value as a number],
  "maxValue": [maximum possible value as a number],
  "mostLikelyValue": [most likely value as a number],
  "explanation": [A detailed explanation including relevant comparables and factors affecting the range]
}

Your explanation MUST include:

1. Factors that could push the value toward either extreme
2. Why you chose this specific range
3. What conditions would result in minimum vs maximum values
4. Why you selected the most likely value
5. Cite specific comparable sales that inform these conclusions`;
}