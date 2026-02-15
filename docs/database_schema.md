# Database Schema

## Status: Not Applicable

ZapSquad is a client-side game engine. There is no persistent database.

## Data Persistence

### Save Game Data
- Stored in browser localStorage or IndexedDB
- Managed by infrastructure/web layer
- Core receives/provides save data as DTOs

### Asset Storage
- Assets served as static files
- Loaded via fetch in infrastructure layer
- Passed to core as parsed DTOs

### Level Data
- LDtk JSON files loaded at runtime
- Parsed in adapters/ layer
- Core receives abstract Level entities

## Gateway Pattern
If future persistence is needed (cloud saves, user accounts):
- Define `SaveGateway` trait in core/
- Implement in adapters/ with specific backend
- Core remains database-agnostic
