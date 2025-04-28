export const TOKEN_LIMIT = 60000;
export const TOKENS_RESERVED = 10000;
export const MAX_AVAILABLE_TOKENS = TOKEN_LIMIT - TOKENS_RESERVED;

export const MAX_DESCRIPTION_LENGTH = 500; // Character limit for descriptions

// Simple estimator for tokens - about 4 chars per token for GPT models
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function trimDescription(description: string, maxLength: number = MAX_DESCRIPTION_LENGTH): string {
  if (!description) return '';
  
  if (description.length <= maxLength) return description;
  
  // Simple approach: trim to max length and try to end at a sentence
  const sentences = description.split(/[.!?]+/);
  let result = '';
  
  for (const sentence of sentences) {
    if (result.length + sentence.length > maxLength) break;
    result += sentence + '.';
  }
  
  return result || description.substring(0, maxLength) + '...';
}