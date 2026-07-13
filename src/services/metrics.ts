import client from 'prom-client';

export const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

const upstreamDuration = new client.Histogram({
  name: 'valuer_auction_data_request_duration_seconds',
  help: 'Valuer Bridge Auction Data API request latency by outcome',
  labelNames: ['status'],
  buckets: [0.1, 0.25, 0.5, 0.75, 1, 2, 3, 5, 8, 12],
  registers: [metricsRegistry],
});
const upstreamRequests = new client.Counter({
  name: 'valuer_auction_data_requests_total',
  help: 'Valuer Bridge Auction Data API requests by outcome',
  labelNames: ['status'],
  registers: [metricsRegistry],
});
const upstreamResults = new client.Histogram({
  name: 'valuer_auction_data_result_count',
  help: 'Lots returned per Auction Data API request',
  buckets: [0, 1, 3, 6, 10, 20, 50, 100, 200],
  registers: [metricsRegistry],
});
const batches = new client.Counter({
  name: 'valuer_batch_requests_total',
  help: 'Valuer batch outcomes',
  labelNames: ['status'],
  registers: [metricsRegistry],
});
const legacyEndpoints = new client.Counter({
  name: 'valuer_legacy_endpoint_requests_total',
  help: 'Requests to removed Valuer Bridge endpoints, labeled only by static route name',
  labelNames: ['endpoint'],
  registers: [metricsRegistry],
});

export function recordUpstreamSearch(status: string, durationMs: number, resultCount?: number): void {
  upstreamRequests.labels(status).inc();
  upstreamDuration.labels(status).observe(Math.max(0, durationMs) / 1000);
  if (status === 'success' && resultCount !== undefined) upstreamResults.observe(resultCount);
}

export function recordBatchOutcome(completed: number, failed: number): void {
  const status = failed === 0 ? 'success' : (completed > 0 ? 'partial' : 'failed');
  batches.labels(status).inc();
}

export function recordLegacyEndpointRequest(endpoint: string): void {
  legacyEndpoints.labels(endpoint).inc();
}
