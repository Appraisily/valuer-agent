#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = fs.readFileSync(path.join(root, 'env.schema'), 'utf8');
const required = schema
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#') && /#\s*(REQUIRED|INFRA)\s*$/.test(line))
  .map(line => line.split(/\s+/)[0]);
const missing = required.filter(key => !String(process.env[key] || '').trim());
if (missing.length) {
  console.error(`[env-check] valuer-bridge missing required variables: ${missing.join(', ')}`);
  process.exit(78);
}
console.log(`[env-check] valuer-bridge passed (${required.length} required/infra variables)`);
