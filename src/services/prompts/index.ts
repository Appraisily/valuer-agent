export function formatAuctionResults(results: any[]): string {
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
Find auction results that justify or challenge the value of ${value} for:
"${text}"

Here are auction results for comparison:

${formatAuctionResults(allResults)}

Format your response as:
{
  "explanation": [Very brief 3-4 line summary of whether the value is reasonable],
  "auctionResults": [
    {
      "title": [lot title],
      "price": [realized price],
      "currency": [currency code],
      "house": [auction house name],
      "date": [sale date],
      "description": [lot description if available]
    },
    ... up to 10 most relevant results
  ]
}

IMPORTANT:
- Extremely concise explanation - maximum 4 lines only
- Focus only on key facts: is the value reasonable? why/why not?
- Include exactly 10 auction results, prioritizing the most relevant comparables
- Present clear conclusion about the value with minimal justification
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