import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLotImageAssetContract } from '../services/scraper-db.js';

function withPublicAssetsRoot<T>(fn: (root: string) => T): T {
  const previousBase = process.env.PUBLIC_ASSETS_BASE_URL;
  const previousRoot = process.env.PUBLIC_STORAGE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valuer-assets-'));
  process.env.PUBLIC_ASSETS_BASE_URL = 'https://assets.example.test';
  process.env.PUBLIC_STORAGE_ROOT = root;

  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousBase === undefined) delete process.env.PUBLIC_ASSETS_BASE_URL;
    else process.env.PUBLIC_ASSETS_BASE_URL = previousBase;
    if (previousRoot === undefined) delete process.env.PUBLIC_STORAGE_ROOT;
    else process.env.PUBLIC_STORAGE_ROOT = previousRoot;
  }
}

describe('buildLotImageAssetContract', () => {
  it('returns null image fields for missing paths', () => {
    expect(buildLotImageAssetContract(null)).toMatchObject({
      imagePath: null,
      thumbUrl: null,
      imageUrl: null,
      originalUrl: null,
    });
  });

  it('normalizes auction lot image URLs into the public asset contract', () => {
    withPublicAssetsRoot((root) => {
      const relativePath = 'auction-lots/example/original/image.jpg';
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, 'image');

      const result = buildLotImageAssetContract(`/${relativePath}`);
      expect(result.imagePath).toBe(relativePath);
      expect(result.imageUrl).toBe(`https://assets.example.test/${relativePath}`);
      expect(result.originalUrl).toBe(`https://assets.example.test/${relativePath}`);
    });
  });

  it('does not emit URLs for missing public files', () => {
    withPublicAssetsRoot(() => {
      const result = buildLotImageAssetContract('/auction-lots/example/original/missing.jpg');
      expect(result).toMatchObject({
        imagePath: null,
        thumbUrl: null,
        imageUrl: null,
        originalUrl: null,
      });
    });
  });

  it('rejects external auction image URLs', () => {
    withPublicAssetsRoot(() => {
      const result = buildLotImageAssetContract('https://auction.example.com/images/lot.jpg');
      expect(result).toMatchObject({
        imagePath: null,
        thumbUrl: null,
        imageUrl: null,
        originalUrl: null,
      });
    });
  });
});
