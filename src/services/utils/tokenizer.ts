export const TOKEN_LIMIT = 60000;
export const TOKENS_RESERVED = 10000;
export const MAX_AVAILABLE_TOKENS = TOKEN_LIMIT - TOKENS_RESERVED;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function trimDescription(description: string, maxTokens: number): string {
  if (!description) return '';
  const currentTokens = estimateTokens(description);
  if (currentTokens <= maxTokens) return description;
  
  const approxCharLimit = maxTokens * 4;
  const sentences = description.split(/[.!?]+/);
  let result = '';
  let totalChars = 0;
  
  for (const sentence of sentences) {
    const nextLength = totalChars + sentence.length;
    if (nextLength > approxCharLimit) break;
    result += sentence + '.';
    totalChars = nextLength;
  }
  
  return result;
}