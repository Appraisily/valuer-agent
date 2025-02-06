export function createSearchStrategyPrompt(text: string, value: number): string {
  return `
As an antiques expert, analyze this item and suggest search queries in order of specificity, from most specific to most general.
Start with the most precise description that would match this exact item, then progressively broaden the terms.
The goal is to find the most relevant matches first, then fall back to broader categories if needed.

Item: "${text}" (Estimated value: $${value})

Format your response as a JSON array of strings, from most specific to most general. Example:
["Victorian mahogany balloon back dining chair circa 1860",
 "Victorian mahogany dining chair",
 "antique mahogany chair",
 "antique dining chair",
 "antique furniture"]`;
}

export function createJustificationPrompt(text: string, value: number, allResults: any[]): string {
  return `
Item to evaluate: "${text}" with proposed value of $${value}

Here are the most relevant auction results found for comparison (all auction details are verifiable):

${formatAuctionResults(allResults)}

Based on this market data, please provide a detailed justification or challenge of the proposed value.

In your analysis:
1. Start with a clear summary of the most comparable auction results, citing specific lot titles, sale dates, and auction houses. Make sure to include the exact lot titles so readers can verify the sales.
2. Compare the proposed value of ${value} ${allResults[0]?.data[0]?.currency || 'USD'} to these actual sales
3. Note any significant condition, quality, or feature differences that might affect the value
4. If relevant, mention any price trends visible in the data (e.g., changes over time or by region)
5. Conclude with a clear statement supporting or challenging the proposed value based on the auction evidence

Keep your response focused and concise, always referencing specific auction results with their exact lot titles and sale information to support your conclusions. This allows readers to verify the sales data independently.`;
}

export function createValueFinderPrompt(text: string, allResults: any[]): string {
  return `
Item to evaluate: "${text}"

Here are the actual auction results found for comparison:

${formatAuctionResults(allResults)}

Based on this market data, please:
1. Calculate a precise market value for the item, rounded to the nearest $50
2. ONLY use the auction results provided above - DO NOT invent or fabricate any sales data
3. For each comparable sale you reference, you MUST include:
   - The exact lot title as shown in the data
   - The specific auction house name
   - The exact sale date
   - The realized price with currency
   - Any relevant condition or detail notes from the lot description
3. Format your response as follows:

{
  "calculatedValue": [your calculated value as a number],
  "explanation": [A detailed explanation citing ONLY actual auction results with complete sale details]
}

CRITICAL: If there are insufficient actual comparable sales in the provided data, acknowledge this limitation in your explanation and adjust your confidence level accordingly. Never invent or assume sales data that isn't present in the results above.`;
}

export function createValueRangeFinderPrompt(text: string, allResults: any[]): string {
  return `
Item to evaluate: "${text}"

Here are the most relevant auction results found for comparison (all auction details are verifiable):

${formatAuctionResults(allResults)}

Based on this market data, please:
1. Calculate a broad value range for the item that accounts for all possible variations in condition, provenance, and market fluctuations
2. The range should be very wide to account for uncertainty, with at least a 250% difference between minimum and maximum values
3. Also provide a most likely value within this range
4. Select the most relevant comparable sales that support this valuation range

Format your response as follows:

{
  "minValue": [minimum possible value as a number],
  "maxValue": [maximum possible value as a number],
  "mostLikelyValue": [most likely value as a number],
  "explanation": [A detailed explanation including relevant comparables and factors affecting the range]
}

Your explanation should discuss:
1. Factors that could push the value toward either extreme
2. Why you chose this specific range
3. What conditions would result in minimum vs maximum values
4. Why you selected the most likely value
5. Cite specific comparable sales that inform these conclusions`;
}

function formatAuctionResults(results: any[]): string {
  return results.map(result => `
${result.relevance === 'high' ? 'Direct Matches' : 'Related Items'} (Search: "${result.query}"):

${result.data.map((item: any) => `
• Lot Title: "${item.title.trim()}"
  Sale: ${item.house} - ${item.date}
  Realized Price: ${item.currency} ${item.price.toLocaleString()}
  ${item.description ? `Details: ${item.description.trim()}` : ''}`).join('\n\n')}
`).join('\n');
}

export { createValueRangeFinderPrompt };