import express from 'express';
import { config } from 'dotenv';
import { z } from 'zod';
import OpenAI from 'openai';
import { ValuerService } from './services/valuer.js';
import { JustifierAgent } from './services/justifier.js';

config();

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const valuer = new ValuerService();
const justifier = new JustifierAgent(openai, valuer);

const RequestSchema = z.object({
  text: z.string(),
  value: z.number(),
});

app.post('/api/justify', async (req, res) => {
  try {
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
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});