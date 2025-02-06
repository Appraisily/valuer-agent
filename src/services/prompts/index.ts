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