# Storage (`ui/web/src/storage/`)

## Role: Data Persistence
This module handles reading and writing data (Assets, Levels, Scripts). It abstracts the underlying storage mechanism via the `StorageGateway` interface.

## Interface
```typescript
interface StorageGateway {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<ArrayBuffer>;
  writeText(path: string, content: string): Promise<void>;
  writeBytes(path: string, data: ArrayBuffer, contentType?: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  getUploadUrl(path: string, contentType: string): Promise<UploadUrl>;
  getReadUrl(path: string): string; // synchronous
}
```

## Implementations

### IdbStorage (Default)
IndexedDB-backed with read-through CDN cache. Used in both dev and production.

- **Read:** IDB first, CDN/local fallback, auto-caches in IDB
- **Write:** IDB only (no disk writes, no S3)
- **List:** Merges IDB paths + CDN listing (via `/__list-files` in dev)
- **getReadUrl:** Returns blob URL (for IDB data) or CDN URL (fallback)
- **Init:** Pre-creates blob URLs from IDB for all binary files under basePath

How it works under the hood:
- Uses the `files` object store in the shared "zapsquad" IndexedDB database
- Keys are full paths: `{basePath}/{relativePath}` (e.g., `mods/tiles/iarba/tile_0.png`)
- Values are `{ data: ArrayBuffer, contentType: string, updatedAt: number }`
- On first read of a seed asset, fetches from CDN and caches in IDB
- On subsequent reads, serves directly from IDB (no network)
- Binary files (PNG/JPG/WebP) get blob URLs for synchronous `getReadUrl()`

### LocalStorage (Dev Override)
Uses the Vite dev server's file system access. Set `VITE_STORAGE_BACKEND=local` to force.
- **Read:** Fetches from `/mods/{path}`
- **Write:** POSTs to `/__write-file` endpoint (Vite plugin)
- **List:** GETs from `/__list-files` endpoint
- Base path: `public/mods/`

### S3Storage (Production Override)
AWS S3 with Cognito auth. Set `VITE_STORAGE_BACKEND=s3` to force.
- Uses presigned URLs for read/write operations
- Requires AWS credentials configuration

## Storage Selection
```
createStorage() → IdbStorage (default)
VITE_STORAGE_BACKEND=local → LocalStorage
VITE_STORAGE_BACKEND=s3 → S3Storage
```

## File Paths
All paths are relative to the storage root (basePath, default "mods"):
```
tiles/{id}/definition.json
tiles/{id}/tile_0.png
characters/{id}/definition.json
characters/{id}/{id}_full_idle_south_0.png
objects/{id}/definition.json
objects/{id}/{id}_new_idle_0.png
weapons/{id}/definition.json
weapons/{id}/{id}_melee_attack_east_0.png
levels/{name}.json
```

## Usage
```typescript
import { createStorage } from './storage';

const storage = createStorage();

// Read a file (IDB → CDN fallback → cache in IDB)
const json = await storage.readText('tiles/grass/definition.json');

// Write a file (IDB only)
await storage.writeText('tiles/grass/definition.json', JSON.stringify(def));

// Write an image (IDB + creates blob URL)
await storage.writeBytes('tiles/grass/tile_0.png', pngBuffer, 'image/png');

// List files (IDB + CDN merged)
const files = await storage.list('tiles');

// Get URL for image display (blob URL or CDN URL)
const url = storage.getReadUrl('tiles/grass/tile_0.png');
```
