export type { StorageGateway, StorageConfig, UploadUrl } from './types';
export { LocalStorage } from './LocalStorage';
export { S3Storage } from './S3Storage';
export { IdbStorage } from './IdbStorage';

import { IdbStorage } from './IdbStorage';
import { LocalStorage } from './LocalStorage';
import { S3Storage } from './S3Storage';
import type { StorageGateway, StorageConfig } from './types';

/**
 * Create a storage gateway.
 *
 * Default: IdbStorage (IndexedDB-backed, read-through cache from CDN).
 * This works in both dev and production without configuration.
 *
 * IdbStorage reads from IDB first, falls back to CDN/local fetch,
 * and caches fetched data in IDB. Writes always go to IDB.
 * This means seed assets from disk auto-populate IDB on first read.
 *
 * Set VITE_STORAGE_BACKEND=local to force LocalStorage (Vite dev server
 * file writes) for debugging the old pipeline.
 */
export function createStorage(config?: StorageConfig): StorageGateway {
  const backend = import.meta.env.VITE_STORAGE_BACKEND;

  // Explicit override: force LocalStorage (dev-only file writes)
  if (backend === 'local') {
    return new LocalStorage(config?.basePath ?? 'mods');
  }

  // Explicit override: force S3Storage (production)
  if (backend === 's3') {
    if (!config?.bucket || !config?.region || !config?.identityPoolId) {
      throw new Error('S3 storage requires bucket, region, and identityPoolId');
    }
    return new S3Storage(config);
  }

  // Default: IdbStorage (works everywhere)
  return new IdbStorage(config?.basePath ?? 'mods');
}

/**
 * Storage configuration from environment variables.
 */
export function getStorageConfig(): StorageConfig {
  return {
    basePath: import.meta.env.VITE_STORAGE_BASE_PATH ?? 'mods',
    bucket: import.meta.env.VITE_S3_BUCKET,
    region: import.meta.env.VITE_AWS_REGION,
    identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID,
  };
}
