# Storage (`ui/web/src/storage/`)

## Role: Data Persistence
This module handles reading and writing data (Assets, Levels, Scripts). It abstracts the underlying storage mechanism (Local File System via Vite proxy, LocalStorage, or S3).

## implementations
- **LocalStorage**: Browser's `localStorage` (for settings/simple data).
- **FileSystem**: Proxies requests to the Vite dev server to write files to disk (Dev Mode).
- **S3Storage**: AWS S3 integration (Production Mode).
