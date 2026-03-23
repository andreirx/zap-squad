import type { StorageGateway, UploadUrl } from './types';
import { fileStore } from '../lib/idb';

/**
 * IndexedDB-backed storage implementation.
 *
 * Implements the StorageGateway interface using the shared "zapsquad" IndexedDB
 * `files` object store. This replaces LocalStorage (Vite dev server writes) and
 * S3Storage (production writes) as the primary persistence mechanism.
 *
 * Read strategy (read-through cache):
 *   1. Check IDB `files` store for the path
 *   2. If miss, fetch from CDN/local (e.g., /mods/tiles/iarba/tile_0.png)
 *   3. Cache the fetched data in IDB for future reads
 *   4. Return the data
 *
 * Write strategy:
 *   - All writes go to IDB only. No disk writes, no S3 uploads.
 *   - Blob URLs are created for written binary data (images) so that
 *     synchronous getReadUrl() can return a valid URL.
 *
 * getReadUrl() is synchronous (interface contract). It returns:
 *   - A blob URL if the data was written via writeBytes() this session
 *   - A blob URL if pre-warmed via init()
 *   - A CDN/local URL as fallback (works for seed assets on disk)
 *
 * For user-created assets to survive browser restarts, call init() at startup.
 * This pre-creates blob URLs from IDB data for all files under this basePath.
 */
export class IdbStorage implements StorageGateway {
  private basePath: string;
  /** In-memory blob URL cache: IDB path key → blob URL. */
  private blobUrls = new Map<string, string>();
  /** Set of paths known to be in IDB (populated by init). */
  private knownPaths = new Set<string>();
  /** Resolves when the IDB index is loaded. Async methods await this. */
  private initPromise: Promise<void>;

  constructor(basePath: string = 'mods') {
    this.basePath = basePath;
    this.initPromise = this._loadIndex();
  }

  /**
   * Pre-load the path index from IDB and create blob URLs for binary files.
   * Called automatically in constructor. Editors can await this if they need
   * getReadUrl() to work for user assets on first render.
   */
  async init(): Promise<void> {
    return this.initPromise;
  }

  private async _loadIndex(): Promise<void> {
    try {
      const allKeys = await fileStore.list();
      const prefix = this.basePath + '/';
      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          this.knownPaths.add(key);
          // Pre-create blob URLs for binary files (images)
          // so getReadUrl() can return them synchronously.
          if (this._isBinaryPath(key)) {
            const record = await fileStore.load(key);
            if (record) {
              const blob = new Blob([record.data], { type: record.contentType });
              this.blobUrls.set(key, URL.createObjectURL(blob));
            }
          }
        }
      }
    } catch (err) {
      console.warn('[IdbStorage] failed to load index:', err);
    }
  }

  /** Heuristic: is this path a binary file (image)? */
  private _isBinaryPath(path: string): boolean {
    return path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.webp');
  }

  /** Full IDB key for a relative path. */
  private _key(path: string): string {
    return `${this.basePath}/${path}`;
  }

  async readText(path: string): Promise<string> {
    await this.initPromise;
    const key = this._key(path);

    // 1. Try IDB
    if (this.knownPaths.has(key)) {
      const record = await fileStore.load(key);
      if (record) {
        return new TextDecoder().decode(record.data);
      }
    }

    // 2. Fall back to CDN/local fetch
    const url = `/${this.basePath}/${path}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to read ${path}: ${resp.status}`);
    }
    const text = await resp.text();

    // 3. Cache in IDB for next time
    const encoded = new TextEncoder().encode(text);
    await fileStore.save(key, encoded.buffer as ArrayBuffer, 'text/plain');
    this.knownPaths.add(key);

    return text;
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    await this.initPromise;
    const key = this._key(path);

    // 1. Try IDB
    if (this.knownPaths.has(key)) {
      const record = await fileStore.load(key);
      if (record) return record.data;
    }

    // 2. Fall back to CDN/local fetch
    const url = `/${this.basePath}/${path}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to read ${path}: ${resp.status}`);
    }
    const data = await resp.arrayBuffer();

    // 3. Cache in IDB
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    await fileStore.save(key, data, contentType);
    this.knownPaths.add(key);

    // 4. Also create blob URL for subsequent getReadUrl calls
    if (this._isBinaryPath(path)) {
      const blob = new Blob([data], { type: contentType });
      this.blobUrls.set(key, URL.createObjectURL(blob));
    }

    return data;
  }

  async writeBytes(path: string, data: ArrayBuffer, contentType?: string): Promise<void> {
    await this.initPromise;
    const key = this._key(path);
    const ct = contentType || (this._isBinaryPath(path) ? 'image/png' : 'application/octet-stream');

    // 1. Write to IDB (primary persistence)
    await fileStore.save(key, data, ct);
    this.knownPaths.add(key);

    // 2. In dev mode, also write to disk via Vite endpoint.
    //    This keeps public/mods/ in sync so bake-atlases reads the latest data.
    if (import.meta.env.DEV) {
      try {
        const fullPath = `public/${this.basePath}/${path}`;
        const base64 = arrayBufferToBase64(data);
        await fetch('/__write-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fullPath, content: base64 }),
        });
      } catch {
        // Disk write failed — IDB still has the data, not critical
      }
    }

    // 3. Create/update blob URL so getReadUrl() returns it immediately
    if (this._isBinaryPath(path)) {
      const old = this.blobUrls.get(key);
      if (old) URL.revokeObjectURL(old);

      const blob = new Blob([data], { type: ct });
      this.blobUrls.set(key, URL.createObjectURL(blob));
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    const encoded = new TextEncoder().encode(content);
    await this.writeBytes(path, encoded.buffer as ArrayBuffer, 'text/plain');
  }

  async list(prefix: string): Promise<string[]> {
    await this.initPromise;
    const fullPrefix = this._key(prefix);
    const baseLen = this.basePath.length + 1; // "mods/" length

    // 1. Collect IDB paths matching prefix
    const idbPaths = new Set<string>();
    for (const key of this.knownPaths) {
      if (key.startsWith(fullPrefix)) {
        idbPaths.add(key.slice(baseLen));
      }
    }

    // 2. Try /__list-files endpoint (Vite dev server only).
    if (import.meta.env.DEV) {
      try {
        const cdnPrefix = `public/${this.basePath}/${prefix}`;
        const resp = await fetch(`/__list-files?prefix=${encodeURIComponent(cdnPrefix)}`);
        if (resp.ok) {
          const { files } = await resp.json();
          const cdnBaseLen = `public/${this.basePath}/`.length;
          for (const f of files as string[]) {
            idbPaths.add(f.startsWith(`public/${this.basePath}/`) ? f.slice(cdnBaseLen) : f);
          }
        }
      } catch (err) {
        console.warn('[IdbStorage] /__list-files fetch failed, trying manifest fallback:', err);
      }
    }

    // 3. Manifest fallback: if still empty, derive file listing from manifest.json.
    //    The manifest lists all seed assets with their IDs. We synthesize the
    //    directory structure that editors expect (e.g., tiles/{id}/definition.json).
    //    This works even when /__list-files is blocked (Safari COEP) or in production.
    if (idbPaths.size === 0) {
      try {
        const manifestUrl = this.basePath === 'assets'
          ? '/assets/manifest.json'
          : '/assets/manifest.json';
        const resp = await fetch(manifestUrl);
        if (resp.ok) {
          const manifest = await resp.json() as Record<string, Record<string, { id: string }>>;
          // Map prefix to manifest section: "tiles" → manifest.tiles, etc.
          const section = prefix.replace(/\/$/, ''); // "tiles", "characters", "weapons", "levels"
          const entries = manifest[section];
          if (entries && typeof entries === 'object') {
            for (const id of Object.keys(entries)) {
              // Synthesize paths the editors scan for
              idbPaths.add(`${section}/${id}/definition.json`);
              idbPaths.add(`${section}/${id}/properties.json`);
            }
          }
          if (idbPaths.size > 0) {
            console.log(`[IdbStorage] manifest fallback: found ${idbPaths.size} paths for "${prefix}"`);
          }
        }
      } catch {
        // Manifest also unavailable — truly empty
      }
    }

    return Array.from(idbPaths).sort();
  }

  async exists(path: string): Promise<boolean> {
    await this.initPromise;
    const key = this._key(path);
    if (this.knownPaths.has(key)) return true;

    // Fall back to CDN check
    try {
      const resp = await fetch(`/${this.basePath}/${path}`, { method: 'HEAD' });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async delete(path: string): Promise<void> {
    const key = this._key(path);
    await fileStore.delete(key);
    this.knownPaths.delete(key);

    // Revoke blob URL if cached
    const blobUrl = this.blobUrls.get(key);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      this.blobUrls.delete(key);
    }
  }

  async getUploadUrl(path: string, _contentType: string): Promise<UploadUrl> {
    // IDB doesn't use upload URLs. Return a no-op.
    // Editors that use this pattern (S3 presigned URLs) should use writeBytes instead.
    return {
      url: `idb://${this._key(path)}`,
      method: 'PUT',
    };
  }

  /**
   * Synchronous URL for loading an asset.
   *
   * Returns:
   * - Blob URL if the file was written to IDB (via writeBytes or pre-warmed by init)
   * - CDN/local URL as fallback (works for seed assets served by Vite or CloudFront)
   *
   * For user-created assets to have valid blob URLs after a browser restart,
   * init() must complete first (it pre-warms the blob URL cache from IDB).
   */
  getReadUrl(path: string): string {
    const key = this._key(path);

    // Check blob URL cache (populated by writeBytes, readBytes, or init)
    const blobUrl = this.blobUrls.get(key);
    if (blobUrl) return blobUrl;

    // Fall back to CDN/local URL (works for seed assets on disk)
    return `/${this.basePath}/${path}`;
  }
}

/** Convert ArrayBuffer to base64 string. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
