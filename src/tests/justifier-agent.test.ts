import { describe, it, expect, vi } from 'vitest';
import { JustifierAgent } from '../services/justifier-agent.js';
import { ValuerService } from '../services/valuer.js';
import OpenAI from 'openai';
import type { ValuerSearchResponse } from '../services/valuer.js';

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

  // Create properly typed mock functions
  const mockFindSimilarItems = vi.fn<[string, number], Promise<ValuerSearchResponse>>();
  const mockSearch = vi.fn<[string, number | undefined, number | undefined], Promise<ValuerSearchResponse>>();

  const mockValuerService = {
    findSimilarItems: mockFindSimilarItems,
    search: mockSearch
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
      mockFindSimilarItems.mockResolvedValue({ hits: [] });

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
      mockFindSimilarItems.mockResolvedValue({ hits: [] });

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
            content: JSON.stringify({
              explanation: 'Test justification',
              auctionResults: [
                {
                  title: 'Test Item',
                  price: 1000,
                  currency: 'USD',
                  house: 'Test House',
                  date: '2024-01-01'
                }
              ]
            })
          }
        }]
      };

      vi.mocked(mockOpenAI.chat.completions.create).mockResolvedValue(mockCompletion as any);
      mockFindSimilarItems.mockResolvedValue({ hits: [] });

      const result = await agent.justify('test item', 1000);

      expect(result).toEqual({
        explanation: 'Test justification',
        auctionResults: expect.arrayContaining([expect.objectContaining({ price: 1000 })])
      });
    });
  });
});