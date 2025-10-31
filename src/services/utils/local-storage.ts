import { randomUUID } from 'node:crypto';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - CommonJS module without types
import localStorageModule from '../../../../_shared/local-storage/index.js';

const { Storage } = localStorageModule as { Storage: new (options?: { localRoot?: string }) => any };

const DEFAULT_BUCKET = process.env.LOCAL_STORAGE_BUCKET ?? 'valuer-data';
const localRoot = process.env.LOCAL_STORAGE_ROOT ?? '/mnt/srv-storage';
const baseUrl = process.env.LOCAL_STORAGE_BASE_URL;

let bucket: any | null = null;

try {
  const storage = new Storage({ localRoot });
  bucket = storage.bucket(DEFAULT_BUCKET);
} catch (err) {
  bucket = null;
  console.warn('[valuer-agent] Local storage disabled:', (err as Error)?.message ?? err);
}

export const storageEnabled = bucket !== null;

function normaliseSegment(value: string | undefined | null): string {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\.\./g, '').replace(/^\/+/, '');
}

interface SaveJSONOptions {
  prefix?: string;
  filename?: string;
  data: unknown;
}

export async function saveJSON({ prefix = '', filename, data }: SaveJSONOptions) {
  if (!bucket) return null;
  const segment = normaliseSegment(prefix);
  const key = path.posix.join(segment, filename ?? `${randomUUID()}.json`);
  const file = bucket.file(key);
  await file.save(JSON.stringify(data, null, 2), { contentType: 'application/json' });
  return {
    bucket: bucket.name,
    key,
    absolutePath: file.absolutePath,
    url: baseUrl ? new URL(key, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString() : null
  };
}

export async function archiveJSON(prefix: string, payload: unknown) {
  return saveJSON({ prefix, data: payload });
}
