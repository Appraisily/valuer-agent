#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function run(label, scriptName, args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, scriptName), ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  console.log(`[deploy-smoke] ${label} passed`);
}

const args = process.argv.slice(2);
const container = argValue('--container') || process.env.VALUER_BRIDGE_CONTAINER || null;
const httpOnly = hasFlag('--http-only');

run('http contract', 'valuer-bridge-smoke.mjs', args);

if (!httpOnly && container) {
  run('runtime env', 'runtime-env-smoke.mjs', ['--container', container]);
  run('recent logs', 'log-smoke.mjs', ['--container', container, '--since', argValue('--log-since') || '5m']);
}

console.log('[deploy-smoke] PASS');
