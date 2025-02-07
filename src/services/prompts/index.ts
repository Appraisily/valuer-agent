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

Based on this market data, provide:
1. A value range with minimum, maximum, and most likely values
2. A brief explanation (max 50 words) of the valuation rationale
3. The top 10 most relevant auction results that support your analysis

Format your response as follows:
{
  "minValue": [minimum possible value as a number],
  "maxValue": [maximum possible value as a number],
  "mostLikelyValue": [most likely value as a number],
  "explanation": [Brief 50-word summary explaining the valuation],
  "auctionResults": [
    {
      "title": [lot title],
      "price": [realized price],
      "currency": [currency code],
      "house": [auction house name],
      "date": [sale date],
      "description": [lot description if available]
    },
    ... up to 10 results
  ]
}

IMPORTANT:
- Keep the explanation concise (50 words max)
- Include exactly 10 auction results, prioritizing the most relevant comparables
- Ensure values show a realistic range with at least 350% difference between min and max`;
}