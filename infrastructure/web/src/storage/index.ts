export type { StorageGateway, StorageConfig, UploadUrl } from './types';
export { LocalStorage } from './LocalStorage';
export { S3Storage } from './S3Storage';

import { LocalStorage } from './LocalStorage';
import { S3Storage } from './S3Storage';
import type { StorageGateway, StorageConfig } from './types';

/**
 * Create a storage gateway based on environment
 * - Development: LocalStorage using Vite dev server
 * - Production: S3Storage using Cognito auth
 */
export function createStorage(config?: StorageConfig): StorageGateway {
  const isDev = import.meta.env.DEV;

  if (isDev) {
    return new LocalStorage(config?.basePath ?? 'mods');
  }

  if (!config?.bucket || !config?.region || !config?.identityPoolId) {
    throw new Error('S3 storage requires bucket, region, and identityPoolId');
  }

  return new S3Storage(config);
}

/**
 * Storage configuration from environment variables
 */
export function getStorageConfig(): StorageConfig {
  return {
    basePath: import.meta.env.VITE_STORAGE_BASE_PATH ?? 'mods',
    bucket: import.meta.env.VITE_S3_BUCKET,
    region: import.meta.env.VITE_AWS_REGION,
    identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID,
  };
}
