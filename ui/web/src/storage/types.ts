/**
 * Storage gateway interface for asset persistence
 * Abstracts local filesystem (dev) vs S3 (deployed) storage
 */
export interface StorageGateway {
  /** Read file as text */
  readText(path: string): Promise<string>;

  /** Read file as binary */
  readBytes(path: string): Promise<ArrayBuffer>;

  /** Write binary data to file */
  writeBytes(path: string, data: ArrayBuffer, contentType?: string): Promise<void>;

  /** Write text to file */
  writeText(path: string, content: string): Promise<void>;

  /** List files with given prefix */
  list(prefix: string): Promise<string[]>;

  /** Check if file exists */
  exists(path: string): Promise<boolean>;

  /** Delete a file */
  delete(path: string): Promise<void>;

  /** Get a URL to upload a file (for presigned URL pattern) */
  getUploadUrl(path: string, contentType: string): Promise<UploadUrl>;

  /** Get a URL to read a file */
  getReadUrl(path: string): string;
}

/** Upload URL with method and headers */
export interface UploadUrl {
  url: string;
  method: 'PUT' | 'POST';
  headers?: Record<string, string>;
}

/** Storage configuration */
export interface StorageConfig {
  /** Base path for assets (e.g., 'mods' for /mods/) */
  basePath: string;
  /** S3 bucket name (deployed only) */
  bucket?: string;
  /** S3 region (deployed only) */
  region?: string;
  /** Cognito identity pool ID (deployed only) */
  identityPoolId?: string;
}
