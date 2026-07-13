'use strict';

const fsp = require('fs/promises');
const path = require('path');

function normalizeRelativePath(relative = '') {
  return String(relative || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.+/g, '');
}

function normalizeBucketName(name = '') {
  const raw = String(name || '').trim();
  if (!raw) throw new Error('Bucket name is required');
  if (path.isAbsolute(raw)) throw new Error('Unsafe bucket name');
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Unsafe bucket name');
  }
  return segments.join('/');
}

class LocalFile {
  constructor(bucket, relativePath) {
    this.bucket = bucket;
    this.relativePath = normalizeRelativePath(relativePath);
  }

  get name() {
    return this.relativePath;
  }

  async save(buffer, options = {}) {
    const absolute = this.bucket.resolve(this.relativePath);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, buffer);
    this.contentType = options.contentType || null;
    return absolute;
  }

  async exists() {
    try {
      await fsp.access(this.resolve());
      return [true];
    } catch (_) {
      return [false];
    }
  }

  async download() {
    const buffer = await fsp.readFile(this.resolve());
    return [buffer];
  }

  async getSignedUrl() {
    const publicUrl = this.bucket.buildPublicUrl(this.relativePath);
    return [publicUrl || null];
  }

  publicUrl() {
    return this.bucket.buildPublicUrl(this.relativePath);
  }

  resolve() {
    return this.bucket.resolve(this.relativePath);
  }
}

class LocalBucket {
  constructor({ name, rootPath, baseUrl }) {
    this.name = name;
    this.rootPath = rootPath;
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/+$/, '') : null;
  }

  async ensureReady() {
    await fsp.mkdir(this.rootPath, { recursive: true });
  }

  resolve(relativePath = '') {
    const safe = normalizeRelativePath(relativePath);
    return path.join(this.rootPath, safe);
  }

  buildPublicUrl(relativePath) {
    if (!this.baseUrl) return null;
    const safe = normalizeRelativePath(relativePath);
    return `${this.baseUrl}/${this.name}/${safe}`.replace(/([^:]\/)\/+/g, '$1');
  }

  file(relativePath) {
    return new LocalFile(this, relativePath);
  }

  async getFiles({ prefix = '' } = {}) {
    const safePrefix = normalizeRelativePath(prefix);
    const files = [];

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relFromRoot = normalizeRelativePath(path.relative(this.rootPath, fullPath));
          if (!safePrefix || relFromRoot.startsWith(safePrefix)) {
            files.push(new LocalFile(this, relFromRoot));
          }
        }
      }
    };

    const baseDir = safePrefix ? path.join(this.rootPath, safePrefix) : this.rootPath;
    await walk(baseDir);
    return [files];
  }
}

class LocalStorage {
  constructor({ localRoot = '/mnt/srv-storage', baseUrl = null } = {}) {
    this.localRoot = localRoot;
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/+$/, '') : null;
  }

  bucket(name) {
    const safeName = normalizeBucketName(name);
    const root = path.resolve(this.localRoot);
    const bucketRoot = path.resolve(root, safeName);
    if (bucketRoot !== root && !bucketRoot.startsWith(`${root}${path.sep}`)) {
      throw new Error('Unsafe bucket name');
    }
    return new LocalBucket({
      name: safeName,
      rootPath: bucketRoot,
      baseUrl: this.baseUrl
    });
  }
}

module.exports = { Storage: LocalStorage, normalizeBucketName };

