# Storage (`ui/web/src/storage/`)

## Role: Data Persistence
This module handles reading and writing data (Assets, Levels, Scripts). It abstracts the underlying storage mechanism.

## Interface
```typescript
interface StorageGateway {
  // Read text file
  readText(path: string): Promise<string>;

  // Write text file
  writeText(path: string, content: string): Promise<void>;

  // Write binary file (images)
  writeBytes(path: string, data: ArrayBuffer, mimeType?: string): Promise<void>;

  // List files in directory
  list(prefix: string): Promise<string[]>;

  // Get read URL for a file (for img src, etc.)
  getReadUrl(path: string): string;
}
```

## Implementations

### LocalStorage (Dev Mode)
Uses the Vite dev server's file system access via custom middleware.
- **Read:** Fetches from `/mods/{path}`
- **Write:** POSTs to `/__write-file` endpoint (Vite plugin)
- **List:** GETs from `/__list-files` endpoint
- Base path: `public/mods/`

### S3Storage (Production Mode)
AWS S3 integration with Cognito authentication.
- Uses presigned URLs for read/write operations
- Requires AWS credentials configuration

## Vite Plugin (`vite-plugins/file-write.ts`)
Dev-only middleware that enables file writing from the browser:
- `POST /__write-file` - Writes file to disk
- `GET /__list-files?prefix=...` - Lists files in directory

## File Paths
All paths are relative to the storage root (`public/mods/` in dev):
```
tiles/{id}/definition.json
tiles/{id}/tile_0.png
characters/{id}/definition.json
characters/{id}/{id}_full_idle_south_0.png
objects/{id}/definition.json
objects/{id}/{id}_new_idle_0.png
levels/{name}.json
```

## Usage
```typescript
import { createStorage } from './storage';

const storage = createStorage();

// Read a file
const json = await storage.readText('tiles/grass/definition.json');

// Write a file
await storage.writeText('tiles/grass/definition.json', JSON.stringify(def));

// Write an image
await storage.writeBytes('tiles/grass/tile_0.png', pngBuffer, 'image/png');

// List files
const files = await storage.list('tiles');

// Get URL for image display
const url = storage.getReadUrl('tiles/grass/tile_0.png');
```
