#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function fail(message, details) {
  console.error(`[runtime-env-smoke] FAIL: ${message}`);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

function envNamesFromContainer(container) {
  const raw = execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', container], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).trim();
  const entries = JSON.parse(raw);
  return entries.map((entry) => String(entry).split('=')[0]).filter(Boolean).sort();
}

function envNamesFromProcess() {
  return Object.keys(process.env).sort();
}

const container = argValue('--container') || process.env.VALUER_BRIDGE_CONTAINER || 'valuer-bridge';
const names = hasFlag('--self-env') ? envNamesFromProcess() : envNamesFromContainer(container);
const nameSet = new Set(names);

const required = ['AUCTION_DATA_API_URL', 'AUCTION_DATA_API_KEY'];
const forbidden = [
  'OPENAI_API_KEY',
  'VALUER_AGENT_URL',
  'VALUER_PROVIDER',
  'VALUER_FALLBACK_URL',
  'VALUER_LIVE_PROVIDER_URL',
  'VALUER_FORCE_SKIP_SUMMARY',
  'VALUER_JUSTIFY_DEPRECATION_MODE',
  'VALUER_JUSTIFY_LOW_FACTOR',
  'VALUER_JUSTIFY_HIGH_FACTOR',
  'VALUER_JUSTIFY_MIN_FLOOR',
  'VALUER_EARLY_STOP_AT',
  'PROVIDED_TIER_SPLIT',
];

const missing = required.filter((name) => !nameSet.has(name));
if (missing.length) {
  fail('missing required runtime env names', { missing, observed: names });
}

const presentForbidden = forbidden.filter((name) => nameSet.has(name));
if (presentForbidden.length) {
  fail('forbidden runtime env names are present', { presentForbidden });
}

console.log(`[runtime-env-smoke] ok (${hasFlag('--self-env') ? 'self env' : container})`);
