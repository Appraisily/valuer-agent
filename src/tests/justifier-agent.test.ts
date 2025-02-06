import { describe, it, expect, vi } from 'vitest';
import { JustifierAgent } from '../services/justifier-agent.js';
import { ValuerService } from '../services/valuer.js';
import OpenAI from 'openai';

// Mock types for OpenAI
type MockOpenAI = {
  chat: {
    completions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
};

describe('JustifierAgent', () => {
  const mockOpenAI: MockOpenAI = {
    chat: {
      completions: {
        create: vi.fn()
      }
    }
  };

  const mockValuerService = {
    findSimilarItems: vi.fn(),
    search: vi.fn()
  } as unknown as ValuerService;

  const agent = new JustifierAgent(mockOpenAI as unknown as OpenAI, mockValuerService);

  describe('findValue', () => {
    it('should return a value and explanation', async () => {
      const mockCompletion = {
        choices: [{
          message: {
            content: JSON.stringify({
              calculatedValue: 1000,
              explanation: 'Test explanation'
            })
          }
        }]
      };

      vi.mocked(mockOpenAI.chat.completions.create).mockResolvedValue(mockCompletion as any);
      mockValuerService.findSimilarItems.mockResolvedValue({ hits: [] });

      const result = await agent.findValue('test item');

      expect(result).toEqual({
        value: 1000,
        explanation: 'Test explanation'
      });
    });
  });

  describe('findValueRange', () => {
    it('should return a value range with explanation', async () => {
      const mockCompletion = {
        choices: [{
          message: {
            content: JSON.stringify({
              minValue: 800,
              maxValue: 3000,
              mostLikelyValue: 1500,
              explanation: 'Test range explanation'
            })
          }
        }]
      };

      vi.mocked(mockOpenAI.chat.completions.create).mockResolvedValue(mockCompletion as any);
      mockValuerService.findSimilarItems.mockResolvedValue({ hits: [] });

      const result = await agent.findValueRange('test item');

      expect(result).toEqual({
        minValue: 800,
        maxValue: 3000,
        mostLikelyValue: 1500,
        explanation: 'Test range explanation'
      });
    });
  });

  describe('justify', () => {
    it('should return a justification', async () => {
      const mockCompletion = {
        choices: [{
          message: {
            content: 'Test justification'
          }
        }]
      };

      vi.mocked(mockOpenAI.chat.completions.create).mockResolvedValue(mockCompletion as any);
      mockValuerService.findSimilarItems.mockResolvedValue({ hits: [] });

      const result = await agent.justify('test item', 1000);

      expect(result).toBe('Test justification');
    });
  });
});