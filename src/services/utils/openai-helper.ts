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
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: config.systemMessage },
    { role: 'user', content: config.userPrompt },
  ];

  console.log(`\n=== Calling OpenAI Model: ${config.model} ===`);
  console.log(`System Message: ${config.systemMessage.substring(0, 100)}...`);
  console.log(`User Prompt: ${config.userPrompt.substring(0, 200)}...`);

  try {
    const completion = await openai.chat.completions.create({
      model: config.model,
      messages: messages,
      temperature: config.temperature, // Allow overriding temperature
      max_tokens: config.max_tokens,   // Allow overriding max_tokens
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
    const contentToParse = parserFn ? parserFn(content) : content;
    const parsedJson = JSON.parse(contentToParse) as T;
    console.log('\n=== Parsed JSON Response ===\n', JSON.stringify(parsedJson, null, 2));
    return parsedJson;
  } catch (error) {
    console.error('Failed to parse OpenAI JSON response:', error);
    console.error('Raw content was:', content); // Log the raw content for debugging
    throw new Error('Failed to parse JSON response from OpenAI');
  }
} 