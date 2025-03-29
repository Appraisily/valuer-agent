import express from 'express';
import { z } from 'zod';
import OpenAI from 'openai';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { ValuerService } from './services/valuer.js';
import { JustifierAgent } from './services/justifier-agent.js';
import { StatisticsService } from './services/statistics-service.js';

async function getOpenAIKey() {
  const client = new SecretManagerServiceClient();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT_ID environment variable is not set');
  }
  
  const name = `projects/${projectId}/secrets/OPENAI_API_KEY/versions/latest`;
  
  const [version] = await client.accessSecretVersion({ name });
  return version.payload?.data?.toString() || '';
}

const app = express();
app.use(express.json());

let openai: OpenAI;
let justifier: JustifierAgent;
let statistics: StatisticsService;
const valuer = new ValuerService();

// Initialize OpenAI client with secret
async function initializeOpenAI() {
  const apiKey = await getOpenAIKey();
  openai = new OpenAI({ apiKey });
  justifier = new JustifierAgent(openai, valuer);
  statistics = new StatisticsService(openai, valuer);
}

const RequestSchema = z.object({
  text: z.string(),
  value: z.number(),
});

const FindValueRequestSchema = z.object({
  text: z.string(),
  useAccurateModel: z.boolean().optional(),
});

const AuctionResultsRequestSchema = z.object({
  keyword: z.string(),
  minPrice: z.number().optional(),
  limit: z.number().optional(),
});

const EnhancedStatisticsRequestSchema = z.object({
  text: z.string(),
  value: z.number(),
  limit: z.number().optional(),
  targetCount: z.number().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
});

app.post('/api/justify', async (req, res) => {
  try {
    if (!openai || !justifier) {
      throw new Error('OpenAI client not initialized');
    }

    const { text, value } = RequestSchema.parse(req.body);
    const result = await justifier.justify(text, value);
    res.json({ 
      success: true, 
      explanation: result.explanation,
      auctionResults: result.auctionResults, 
      allSearchResults: result.allSearchResults // Include all search results in response
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(400).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

app.post('/api/find-value', async (req, res) => {
  try {
    if (!openai || !justifier) {
      throw new Error('OpenAI client not initialized');
    }

    const { text } = FindValueRequestSchema.parse(req.body);
    const result = await justifier.findValue(text);
    
    res.json({ 
      success: true, 
      value: result.value,
      explanation: result.explanation
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(400).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

app.post('/api/find-value-range', async (req, res) => {
  try {
    if (!openai || !justifier) {
      throw new Error('OpenAI client not initialized');
    }

    const { text, useAccurateModel } = FindValueRequestSchema.parse(req.body);
    
    console.log(`Processing find-value-range request for: "${text.substring(0, 100)}..." (useAccurateModel: ${useAccurateModel === true})`);
    
    // Use the accurate model if specified
    const result = await justifier.findValueRange(text, useAccurateModel === true);
    
    res.json({
      success: true, 
      minValue: result.minValue,
      maxValue: result.maxValue,
      mostLikelyValue: result.mostLikelyValue,
      explanation: result.explanation,
      auctionResults: result.auctionResults || [],
      confidenceLevel: result.confidenceLevel,
      marketTrend: result.marketTrend,
      keyFactors: result.keyFactors,
      dataQuality: result.dataQuality
    });
    
    console.log(`Completed find-value-range request with confidence: ${result.confidenceLevel}, trend: ${result.marketTrend}`);
  } catch (error) {
    console.error('Error processing find-value-range request:', error);
    res.status(400).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

app.post('/api/auction-results', async (req, res) => {
  try {
    const { keyword, minPrice, limit } = AuctionResultsRequestSchema.parse(req.body);
    
    const results = await valuer.findValuableResults(keyword, minPrice, limit);
    
    // Process the hits to create a more detailed response
    const auctionResults = results.hits.map(hit => ({
      title: hit.lotTitle,
      price: {
        amount: hit.priceResult,
        currency: hit.currencyCode,
        symbol: hit.currencySymbol
      },
      auctionHouse: hit.houseName,
      date: hit.dateTimeLocal,
      lotNumber: hit.lotNumber,
      saleType: hit.saleType
    }));
    
    res.json({
      success: true,
      keyword,
      totalResults: auctionResults.length,
      minPrice: minPrice || 1000,
      auctionResults
    });
  } catch (error) {
    console.error('Error fetching auction results:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Special endpoint designed specifically for the WP2HUGO process:direct:10 workflow
 * This endpoint matches the expected format from the auction-results.service.js
 */
app.post('/api/wp2hugo-auction-results', async (req, res) => {
  try {
    const { keyword, minPrice = 1000, limit = 10 } = AuctionResultsRequestSchema.parse(req.body);
    
    console.log(`WP2HUGO auction results request for: "${keyword}" (minPrice: ${minPrice}, limit: ${limit})`);
    
    const results = await valuer.findValuableResults(keyword, minPrice, limit);
    
    // Calculate price range and median for summary
    const prices = results.hits.map(hit => hit.priceResult).filter(p => p > 0);
    const minFoundPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxFoundPrice = prices.length > 0 ? Math.max(...prices) : 0;
    
    // Find median price
    let medianPrice = 0;
    if (prices.length > 0) {
      const sortedPrices = [...prices].sort((a, b) => a - b);
      const midIndex = Math.floor(sortedPrices.length / 2);
      medianPrice = sortedPrices.length % 2 === 0
        ? (sortedPrices[midIndex - 1] + sortedPrices[midIndex]) / 2
        : sortedPrices[midIndex];
    }
    
    // Map results to the format expected by the WP2HUGO service
    const auctionResults = results.hits.map(hit => ({
      title: hit.lotTitle,
      price: {
        amount: hit.priceResult,
        currency: hit.currencyCode,
        symbol: hit.currencySymbol
      },
      house: hit.houseName,  // Using the expected field name 'house' instead of 'auctionHouse'
      date: hit.dateTimeLocal,
      lotNumber: hit.lotNumber,
      saleType: hit.saleType
    }));
    
    // Generate a market summary based on the results
    let summary = "";
    if (auctionResults.length > 0) {
      summary = `Based on ${auctionResults.length} recent auction results, ${keyword} typically sell for between ${minFoundPrice} and ${maxFoundPrice} ${results.hits[0]?.currencyCode || 'USD'}, with a median value of approximately ${Math.round(medianPrice)} ${results.hits[0]?.currencyCode || 'USD'}. Prices can vary significantly based on condition, rarity, provenance, and market demand.`;
    } else {
      summary = `Limited auction data is available for ${keyword}. Values may vary significantly based on condition, rarity, provenance, and market demand.`;
    }
    
    // Return the response in the format expected by auction-results.service.js
    res.json({
      success: true,
      keyword,
      totalResults: auctionResults.length,
      minPrice: minPrice,
      auctionResults,
      summary,
      priceRange: {
        min: minFoundPrice,
        max: maxFoundPrice,
        median: medianPrice
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching WP2HUGO auction results:', error);
    res.status(400).json({
      success: false,
      keyword: req.body?.keyword || '',
      error: error instanceof Error ? error.message : 'Unknown error',
      auctionResults: [],
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Enhanced Statistics API
 * Provides comprehensive market statistics for an item, optimized for visualization
 */
app.post('/api/enhanced-statistics', async (req, res) => {
  try {
    if (!openai || !statistics) {
      throw new Error('OpenAI client or statistics service not initialized');
    }

    const { text, value, limit = 20, targetCount = 100, minPrice, maxPrice } = EnhancedStatisticsRequestSchema.parse(req.body);
    console.log(`Enhanced statistics request for: "${text}" with value ${value} (target count: ${targetCount}, price range: ${minPrice || 'auto'}-${maxPrice || 'auto'})`);
    
    // Generate comprehensive statistics using the dedicated service
    // Pass the targetCount parameter to control how many auction items to gather
    const enhancedStats = await statistics.generateStatistics(text, value, targetCount, minPrice, maxPrice);
    
    // If a limit is specified, trim the comparable sales to that limit
    if (limit > 0 && limit < enhancedStats.comparable_sales.length) {
      const originalCount = enhancedStats.comparable_sales.length;
      enhancedStats.comparable_sales = enhancedStats.comparable_sales.slice(0, limit);
      enhancedStats.total_count = originalCount;
      console.log(`Limited comparable sales from ${originalCount} to ${limit} for UI display`);
    }
    
    // Return the complete statistics object
    res.json({
      success: true,
      statistics: enhancedStats,
      message: 'Enhanced statistics generated successfully'
    });
  } catch (error) {
    console.error('Error generating enhanced statistics:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Failed to generate enhanced statistics'
    });
  }
});

const port = process.env.PORT || 8080;

// Initialize OpenAI before starting server
initializeOpenAI().then(() => {
  app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  });
}).catch(error => {
  console.error('Failed to initialize OpenAI client:', error);
  process.exit(1);
});