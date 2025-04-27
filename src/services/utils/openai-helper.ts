import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/index.mjs';

/**
 * Configuration for an OpenAI call.
 */
interface OpenAICallConfig {
  model: string;
  systemMessage: string;
  userPrompt: string;
  temperature?: number;
  max_tokens?: number;
  expectJsonResponse?: boolean; // Flag to indicate we're expecting a JSON response
}

/**
 * Makes a call to the OpenAI Chat Completions API and returns the raw content string.
 *
 * @param openai - The initialized OpenAI client instance.
 * @param config - Configuration for the API call (model, messages, etc.).
 * @returns The content string from the AI response.
 * @throws Error if the API call fails or returns no content.
 */
export async function callOpenAI(openai: OpenAI, config: OpenAICallConfig): Promise<string> {
  // Enhance system message with JSON formatting instructions if expecting JSON
  let systemMessage = config.systemMessage;
  if (config.expectJsonResponse) {
    systemMessage = `${systemMessage.trim()} Your response MUST be ONLY valid JSON with no comments, markdown formatting, explanations, or additional text. Do not include \`\`\`json\`\`\` code blocks - return only the raw JSON.`;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: config.userPrompt },
  ];

  console.log(`\n=== Calling OpenAI Model: ${config.model} ===`);
  console.log(`System Message: ${systemMessage.substring(0, 100)}...`);
  console.log(`User Prompt: ${config.userPrompt.substring(0, 200)}...`);

  try {
    const completion = await openai.chat.completions.create({
      model: config.model,
      messages: messages,
      temperature: config.temperature, // Allow overriding temperature
      max_tokens: config.max_tokens,   // Allow overriding max_tokens
      response_format: config.expectJsonResponse ? { type: "json_object" } : undefined, // Use OpenAI's JSON mode when appropriate
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      console.error('OpenAI response missing content:', completion);
      throw new Error('No content received from OpenAI');
    }

    console.log(`\n=== OpenAI Raw Response (${config.model}) ===\n${content.substring(0, 500)}${content.length > 500 ? '...' : ''}`);
    return content;

  } catch (error) {
    console.error(`Error calling OpenAI model ${config.model}:`, error);
    if (error instanceof Error) {
        throw new Error(`OpenAI API call failed: ${error.message}`);
    } else {
        throw new Error('An unknown error occurred during the OpenAI API call');
    }
  }
}

/**
 * Makes a call to the OpenAI Chat Completions API and parses the response as JSON.
 *
 * @param openai - The initialized OpenAI client instance.
 * @param config - Configuration for the API call.
 * @param parserFn - Optional function to preprocess the string before JSON.parse.
 * @returns The parsed JSON object of type T.
 * @throws Error if the API call fails, returns no content, or if JSON parsing fails.
 */
export async function callOpenAIAndParseJson<T>(openai: OpenAI, config: OpenAICallConfig, parserFn?: (content: string) => string): Promise<T> {
  const content = await callOpenAI(openai, config);

  try {
    // If a custom parser is provided, use it first
    let contentToParse = parserFn ? parserFn(content) : content;
    
    // Apply additional cleanups if no custom parser or after custom parser
    // Extract JSON from markdown code blocks if present
    const jsonBlockMatch = contentToParse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonBlockMatch) {
      contentToParse = jsonBlockMatch[1];
    }
    
    // Remove all comments (both line and block comments)
    contentToParse = contentToParse.replace(/\/\/.*$/gm, ''); // Remove line comments
    contentToParse = contentToParse.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove block comments
    
    // Try to find JSON array/object pattern if still not parseable
    if (!contentToParse.trim().startsWith('{') && !contentToParse.trim().startsWith('[')) {
      const jsonMatch = contentToParse.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      if (jsonMatch) {
        contentToParse = jsonMatch[1];
      }
    }
    
    // Trim any leading/trailing whitespace
    contentToParse = contentToParse.trim();
    
    console.log('\n=== Cleaned Content for Parsing ===\n', contentToParse.substring(0, 500));
    
    try {
      const parsedJson = JSON.parse(contentToParse) as T;
      console.log('\n=== Parsed JSON Response ===\n', JSON.stringify(parsedJson, null, 2));
      return parsedJson;
    } catch (parseError) {
      // If parsing failed with our cleanups, try once more with a more aggressive approach
      console.warn('Initial JSON parsing failed, attempting more aggressive cleanup:', parseError);
      
      // More aggressive cleanup - keep only what seems to be JSON content
      const aggressiveMatch = content.match(/(\[\s*\{[\s\S]*\}\s*\]|\{\s*"[\s\S]*"\s*:[\s\S]*\})/);
      if (aggressiveMatch) {
        const aggressiveJson = aggressiveMatch[1];
        console.log('\n=== Aggressively Cleaned Content ===\n', aggressiveJson.substring(0, 500));
        return JSON.parse(aggressiveJson) as T;
      }
      
      // If all attempts fail, throw the original error
      throw parseError;
    }
  } catch (error) {
    console.error('Failed to parse OpenAI JSON response:', error);
    console.error('Raw content (first 1000 chars):', content.substring(0, 1000));
    throw new Error(`Failed to parse JSON response from OpenAI: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
} 