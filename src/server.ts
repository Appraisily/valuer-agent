import express from 'express';
import { z } from 'zod';
import OpenAI from 'openai';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { ValuerService } from './services/valuer';
import { JustifierAgent } from './services/justifier';

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

app.post('/api/justify', async (req, res) => {
  try {
    if (!openai || !justifier) {
      throw new Error('OpenAI client not initialized');
    }

    const { text, value } = RequestSchema.parse(req.body);
    const justification = await justifier.justify(text, value);
    res.json({ success: true, justification });
  } catch (error) {
    console.error('Error:', error);
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