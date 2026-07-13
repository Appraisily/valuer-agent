import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ScraperDbClient, resolveAuctionDataApiConfig } from '../services/scraper-db.js';

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Auction Data API readiness', () => {
  it('reports missing and configured API settings without exposing values', () => {
    expect(resolveAuctionDataApiConfig({ AUCTION_DATA_API_URL: 'http://auction-data', AUCTION_DATA_API_KEY: '' })).toEqual({
      url: 'http://auction-data',
      key: '',
      configured: false,
    });
    expect(resolveAuctionDataApiConfig({ AUCTION_DATA_API_URL: 'http://auction-data/', AUCTION_DATA_API_KEY: 'secret' })).toEqual({
      url: 'http://auction-data',
      key: 'secret',
      configured: true,
    });
  });

  it('moves from not ready to ready when the upstream recovers', async () => {
    let healthy = false;
    const { baseUrl } = await listen((req, res) => {
      expect(req.headers['x-api-key']).toBe('test-key');
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthy ? { success: true } : { success: false }));
    });
    const client = new ScraperDbClient({ dataApiUrl: baseUrl, dataApiKey: 'test-key' });

    await expect(client.checkReadiness(500)).resolves.toMatchObject({
      ready: false,
      status: 503,
      error: 'auction_data_api_503',
    });

    healthy = true;
    await expect(client.checkReadiness(500)).resolves.toMatchObject({
      ready: true,
      status: 200,
      error: null,
    });
  });

  it('returns a bounded timeout diagnostic', async () => {
    const { baseUrl } = await listen((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
      }, 250);
    });
    const client = new ScraperDbClient({ dataApiUrl: baseUrl, dataApiKey: 'test-key' });
    const startedAt = Date.now();

    await expect(client.checkReadiness(100)).resolves.toMatchObject({
      ready: false,
      status: null,
      error: 'auction_data_api_readiness_timeout',
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe('Valuer health routes', () => {
  it('keeps liveness independent while readiness exposes upstream failure', async () => {
    process.env.AUCTION_DATA_API_KEY = 'test-key';
    process.env.AUCTION_DATA_API_URL = 'http://127.0.0.1:9';
    process.env.MESSAGE_TRANSPORT = 'disabled';
    const { app } = await import('../server.js');
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Valuer test server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const live = await fetch(`${baseUrl}/live`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ status: 'ok', service: 'valuer-bridge' });

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'valuer-bridge',
      provider: 'auction_data_api',
      apiConfigured: true,
      readinessEndpoint: '/ready',
    });

    const ready = await fetch(`${baseUrl}/ready`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      status: 'not_ready',
      service: 'valuer-bridge',
      upstream: { ready: false, error: 'auction_data_api_unreachable' },
    });
  });
});
