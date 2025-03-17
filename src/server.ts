import express from 'express';
import { z } from 'zod';
import OpenAI from 'openai';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { ValuerService } from './services/valuer.js';
import { JustifierAgent } from './services/justifier-agent.js';

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
const valuer = new ValuerService();

// Initialize OpenAI client with secret
async function initializeOpenAI() {
  const apiKey = await getOpenAIKey();
  openai = new OpenAI({ apiKey });
  justifier = new JustifierAgent(openai, valuer);
}

const RequestSchema = z.object({
  text: z.string(),
  value: z.number(),
});

const FindValueRequestSchema = z.object({
  text: z.string(),
});

const AuctionResultsRequestSchema = z.object({
  keyword: z.string(),
  minPrice: z.number().optional(),
  limit: z.number().optional(),
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
      auctionResults: result.auctionResults 
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

    const { text } = FindValueRequestSchema.parse(req.body);
    const result = await justifier.findValueRange(text);
    
    res.json({
      success: true, 
      minValue: result.minValue,
      maxValue: result.maxValue,
      mostLikelyValue: result.mostLikelyValue,
      explanation: result.explanation,
      auctionResults: result.auctionResults || []
    });
  } catch (error) {
    console.error('Error:', error);
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