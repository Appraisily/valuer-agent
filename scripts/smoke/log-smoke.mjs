#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function fail(message, details) {
  console.error(`[log-smoke] FAIL: ${message}`);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

const container = argValue('--container') || process.env.VALUER_BRIDGE_CONTAINER || 'valuer-bridge';
const since = argValue('--since') || process.env.LOG_SMOKE_SINCE || '5m';
const raw = execFileSync('docker', ['logs', '--since', since, container], {
  encoding: 'utf8',
  maxBuffer: 5 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const allowPatterns = [
  /Provide non-empty terms/i,
  /terms_required/i,
  /endpoint_removed/i,
  /status":40[01]/i,
  /status":410/i,
];

const blockPatterns = [
  /Failed to initialize OpenAI/i,
  /OPENAI_API_KEY is required/i,
  /Cannot find module/i,
  /ReferenceError/i,
  /TypeError/i,
  /UnhandledPromiseRejection/i,
  /Missing AUCTION_DATA_API_KEY/i,
  /scraper_db_error/i,
  /database .*?(error|failed|connection)/i,
  /ECONNREFUSED/i,
  /Error processing request/i,
];

const blocked = [];
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  if (!blockPatterns.some((pattern) => pattern.test(line))) continue;
  if (allowPatterns.some((pattern) => pattern.test(line))) continue;
  blocked.push(line);
}

if (blocked.length) {
  fail('recent logs contain blocking errors', blocked.slice(-20));
}

console.log(`[log-smoke] ok (${container}, since=${since})`);
