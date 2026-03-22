# Storage Architecture

## Problem Statement

ZapSquad is a static-site application with no backend server. Multiple tools share the same asset library:

- **Tile Editor** — creates and edits 128x128 tile sprites
- **Character Editor** — creates and edits character sprite sheets
- **Map Editor** — composes tiles into LDtk-format levels (discrete, bounded maps)
- **Freedom Board** — infinite sparse canvas for world-building and gameplay

All tools must persist user work across browser sessions. Users must be able to create custom assets, save their progress, and download/upload individual items. The deployed app serves curated seed assets from S3, but user-created content stays entirely local — there is no backend for user content storage or moderation.

---

## Deployment Model

```
+------------------+      +---------------------------+
|  S3 / CloudFront |      |  User's Browser           |
|  (seed assets)   |      |                           |
|  - tile PNGs     |----->|  IndexedDB ("zapsquad")   |
|  - char sprites  |      |  - user-created assets    |
|  - manifest.json |      |  - saved worlds           |
|  - assets.json   |      |  - saved levels           |
|  - baked atlases |      |  - app configuration      |
+------------------+      |                           |
                          |  Runtime Registry         |
                          |  (seed + user merged)     |
                          +---------------------------+
```

**No backend for user content.** This is a deliberate constraint:
- No moderation server needed (no user content on S3 for others to see)
- App works fully offline after initial load
- Zero server costs for user content
- Users own their data completely (download/upload at will)

**Trade-off**: No cross-device sync. Users must manually export/import to transfer work between devices. This is acceptable for the current use case (single-user creative tool). Cross-device sync would require a backend and content moderation — a Phase 6+ concern.

---

## Two-Tier Asset Model

Every asset in the runtime registry has one of two sources:

### Seed Assets (source: "seed")
- Curated content shipped with the application
- Served from S3/CDN (or local Vite dev server)
- Human-readable stable IDs: `"iarba"`, `"ocean"`, `"drum_gri"`
- PNG blobs are NOT stored in IDB (fetched from CDN on demand)
- IDB entry has `blob: null` — metadata only
- Cannot be deleted or modified by users

### User Assets (source: "user")
- Created by users via the Tile/Character editors
- Stored entirely in IndexedDB with actual PNG blobs (ArrayBuffer)
- UUID4 identifiers: `"a3f9c2e1-..."` (generated at creation time)
- Downloadable as JSON+base64 files, uploadable back
- Can be deleted, modified, re-uploaded

### Runtime Merge

At startup, both sources merge into a single unified registry. The engine and all editors operate on this merged registry without knowing or caring about the source:

```
Startup Sequence:
1. Fetch manifest.json from CDN → seed asset metadata
2. Read all assets from IDB → user asset metadata + blobs
3. Merge into runtime registry (seed entries + user entries)
4. Build intern table: UUID string <-> u16 handle
5. Send registry to WASM via reload_game_manifest()
```

**Conflict resolution**: If a user asset has the same UUID as a seed asset (shouldn't happen with UUID4, but defensive), user asset wins. This enables a future "fork seed asset" workflow.

---

## IndexedDB Schema

Single shared database used by all editors and freedom-board.

**Database**: `"zapsquad"`, version 1

### Object Store: `"assets"`

Key: UUID string (out-of-line)
Value:
```typescript
{
  type: "tile" | "character" | "weapon",
  source: "seed" | "user",
  metadata: {
    // Tile-specific:
    name: string,
    tileType: "TILE" | "PATH" | "BRIDGE",
    terrainType: "LAND" | "WATER",
    variations: number,
    bridgeAssetId?: string,
    passable?: boolean,
    movementCost?: number,
    // Character-specific:
    frameDuration?: number,
    // Common:
    createdAt: number,
    updatedAt: number
  },
  blob: ArrayBuffer | null,  // null for seed assets (PNG fetched from CDN)
  updatedAt: number
}
```

### Object Store: `"levels"`

Key: level name string (out-of-line)
Value:
```typescript
{
  ldtk: object,       // Full LDtk JSON (levels, layerInstances, gridTiles, entities)
  updatedAt: number
}
```

### Object Store: `"worlds"`

Key: world name string (out-of-line)
Value:
```typescript
{
  version: 1,
  tiles: [
    { x: number, y: number, uuid: string, variant: number, layer: number, flags: number }
  ],
  characters: [
    { x: number, y: number, bodyDefId: string, direction: string,
      health: number, maxHealth: number }
  ],
  camera: { x: number, y: number, zoom: number },
  updatedAt: number
}
```

**Critical**: Tiles reference assets by UUID string, never by runtime u16 handle. This ensures saves remain valid across sessions even if the asset registry changes (new assets added, order changed, etc.).

### Object Store: `"config"`

Key: arbitrary string (out-of-line)
Value: any serializable value

Used for app preferences: last-opened world, editor settings, UI state. Not type-constrained — each key defines its own schema.

---

## StorageGateway vs IndexedDB

These are two separate persistence mechanisms that coexist. They serve different purposes.

### StorageGateway (existing)

**Purpose**: File-like read/write for the asset pipeline (sprites, definitions, levels).

**Interface** (`ui/web/src/storage/types.ts`):
```
readText(path) / readBytes(path)
writeText(path, data) / writeBytes(path, data)
list(prefix)
exists(path) / delete(path)
getUploadUrl(path) / getReadUrl(path)
```

**Implementations**:
- `LocalStorage` (dev): Vite middleware, reads/writes to `public/mods/` on disk
- `S3Storage` (prod): AWS S3 with Cognito auth, presigned URLs

**What it handles**: The **source asset pipeline** — tile definitions (`tiles/{id}/properties.json`), character definitions (`characters/{id}/definition.json`), level files (`levels/{name}.json`), and sprite PNGs.

**What it does NOT handle**: Runtime state, user preferences, world saves, or any data that needs to survive without a server.

### IndexedDB (new)

**Purpose**: Structured browser-side persistence for all user state.

**What it handles**: Everything that lives in the browser — user-created assets, saved worlds, saved levels, app configuration.

**Why not replace StorageGateway with IDB?**
- StorageGateway serves the **authoring pipeline** (dev: local files, prod: S3 uploads)
- IDB serves the **runtime persistence** (browser storage, no server needed)
- Seed assets fetched from CDN go through StorageGateway's read path
- User assets go through IDB
- Both feed into the same runtime registry

**Long-term**: StorageGateway remains for seed asset management (admin/curator workflow). IDB handles everything on the user's side.

---

## Editor Persistence: Current State vs Target

### Current State (file-based)

All editors save via `StorageGateway`:
- **Tile Editor**: `tiles/{id}/properties.json` + `tile_{n}.png` files
- **Character Editor**: `characters/{id}/definition.json` + sprite PNGs
- **Map Editor**: `levels/{name}.json` (LDtk format)
- **Freedom Board**: No persistence (in-memory only)

This works in dev (local filesystem via Vite) and prod (S3). But it requires a server for writes. Users cannot save work without S3 access.

### Target State (IDB-based)

All editors save to IndexedDB:
- **Tile Editor**: Reads seed tiles from CDN. Saves user tiles (metadata + PNG blob) to IDB `assets` store.
- **Character Editor**: Same pattern. Seed characters from CDN, user characters in IDB.
- **Map Editor**: Reads tile/character definitions from merged registry. Saves levels to IDB `levels` store.
- **Freedom Board**: Saves world state (tiles, characters, camera) to IDB `worlds` store.

The editors continue to use `StorageGateway.readText/readBytes` for **fetching seed assets from CDN**. They stop using `StorageGateway.writeText/writeBytes` for user content — IDB replaces that.

### Migration Path

The editors are not rewritten. They gain an IDB save/load layer alongside their existing StorageGateway read path:

```
Current:  Editor <--read/write--> StorageGateway (Vite FS or S3)

Target:   Editor <--read-------> StorageGateway (CDN, seed assets only)
          Editor <--read/write--> IDB (user assets, levels, worlds)
```

Existing StorageGateway write functionality remains for the curator/admin workflow (uploading new seed assets to S3). User-facing editors default to IDB.

---

## Freedom-Board Persistence Pipeline

### Data Flow: Save

```
1. React: user clicks "Save" (or auto-save timer fires)
2. React: sends { type: 'export_world' } to engine worker
3. Worker: calls request_world_export()        → sets EXPORT_REQUESTED flag
4. Worker: calls game_tick(0)                  → update() runs:
   a. Checks EXPORT_REQUESTED flag
   b. Calls serialize_world():
      - SparseWorld::iter_all() yields all (TileCoord, &TilePlacement)
      - Each tile's u16 asset_id resolved to name string via tile_registry
      - Characters serialized with body_def_id string
      - Camera state included
      - JSON sorted by (x, y, layer) for determinism
   c. Writes JSON to EXPORT_RESULT thread_local
5. Worker: calls take_world_export()           → returns JSON string
6. Worker: posts { type: 'world_export', json } back to React
7. React: calls worldStore.save(name, worldData) → IDB write
```

### Data Flow: Load

```
1. React: user selects world from list (or auto-load on startup)
2. React: calls worldStore.load(name) → reads WorldData from IDB
3. React: sends { type: 'import_world', json } to engine worker
4. Worker: calls import_world(json)            → queues in PENDING_IMPORT
5. Next game_tick() → update() runs:
   a. Consumes PENDING_IMPORT
   b. Calls import_world_from_json():
      - Parses JSON
      - Validates version field
      - Builds reverse lookup: tile name → u16 asset_id
      - Clears world, undo/redo stacks, characters
      - Imports tiles (resolving names to handles)
      - Imports characters
      - Restores camera
   c. Sets camera_dirty + characters_dirty → triggers re-render
```

### Two-Phase Export Pattern

The game instance is owned by the `zap_web::export_game!` macro. Free WASM functions cannot access it directly. The two-phase pattern (request → tick → take) works around this:

1. `request_world_export()` — sets a thread_local flag
2. `game_tick()` — `update()` has `&mut self`, checks flag, serializes, writes result to thread_local
3. `take_world_export()` — reads and clears the result from thread_local

This is single-threaded WASM — no race conditions. The worker orchestrates all three calls synchronously.

### Auto-Save Strategy (not yet implemented)

- Debounced: save 5 seconds after last edit (not on every tile placement)
- Trigger: `SparseWorld.generation()` change detection
- Storage: IDB worldStore with fixed key (e.g., `"autosave"`)
- Manual saves use user-chosen names
- Auto-save does NOT create undo history entries

---

## Download/Upload Strategy

Every piece of user data is individually downloadable and uploadable:

### Tile/Character Assets
```json
{
  "type": "tile",
  "uuid": "iarba",
  "metadata": { "name": "iarba", "tileType": "TILE", "terrainType": "LAND", "variations": 3 },
  "sprites": {
    "iarba_0.png": "<base64>",
    "iarba_1.png": "<base64>",
    "iarba_2.png": "<base64>"
  }
}
```
Base64 PNG encoding adds ~33% overhead. Acceptable for sprite sheets (<500KB each). ZIP compression deferred — not worth the complexity for current asset sizes.

### Levels
Downloaded as-is: LDtk JSON format. Unchanged from current MapEditor output. Can be re-imported by stamping onto freedom-board or loading into MapEditor.

### Worlds
Downloaded as WorldData JSON (same format stored in IDB). Contains UUID-based tile references, characters, camera state. Can be re-imported into any session that has the referenced assets in its registry. Missing assets are skipped with a warning.

### Full Backup (deferred)
Single JSON containing all assets + levels + worlds + config. Or ZIP containing individual files. Deferred until the asset count justifies it.

---

## App Unification Plan

### Current State

Two separate React apps:
- `ui/web/` — main app with React Router, editors (tile, character, map), game pages
- `ui/canvas/` — standalone freedom-board app

### Target State

Single React app (`ui/web/`) with freedom-board as a route:

```
/                     → Freedom Board (or configurable home)
/editor/tile          → Tile Editor
/editor/character     → Character Editor
/editor/map           → Map Editor
/game/wasm            → Legacy WASM game page (retained, not actively developed)
```

### Key Constraints

1. **Freedom-board is the primary focus.** It becomes the vehicle for Rhai scripting, combat, movement — the full game runtime. Editors are supporting tools.

2. **Editors stay on 128x128 source sprites.** They do NOT use feathered 160x160 atlases. The feathering pipeline is a build step between editor output and freedom-board input. Editors are authoring tools that work with raw source assets.

3. **Freedom-board uses baked 160x160 feathered sheets.** These are produced by the `feather_atlases.py` pipeline from the 128x128 editor output.

4. **Both WASM crates coexist.** The existing game WASM crate (used by `/game/wasm`) and the freedom-board WASM crate (`freedom-board-wasm`) are separate. They share the same core library but have different Game trait implementations.

5. **IDB is the shared state layer.** All routes read/write the same "zapsquad" database. An asset created in the Tile Editor appears in the Freedom Board's tile registry.

6. **Route ordering is configurable.** Which route is "home" (`/`) can be changed by configuration. Currently freedom-board is the intended home. If the legacy game page needs to be home temporarily, it's a one-line change.

7. **Legacy game page is retained, not actively developed.** It will be deleted when freedom-board achieves full feature parity. Until then, it serves as reference.

---

## Phased Implementation Plan

### Phase 1: IDB Module (DONE)
- `ui/canvas/src/lib/idb.ts` — generic CRUD over IndexedDB
- Four stores: assets, levels, worlds, config
- Typed accessors: worldStore, levelStore, assetStore, configStore
- Connection pooling with auto-reconnect
- Persistent storage request helper

### Phase 2: WASM World Serialization (DONE)
- `SparseWorld::iter_all()` — zero-alloc iterator over all tiles
- `SparseWorld::clear()` — reset world state for import
- `serialize_world()` — walks tiles, resolves u16 → name string, JSON output
- `import_world_from_json()` — parses JSON, resolves names → u16, replaces world
- WASM exports: `request_world_export()`, `take_world_export()`, `import_world()`

### Phase 3: Engine Worker Bridge (next)
- Add `export_world` message type to `engine.worker.ts` in @zap/web
- Add `import_world` message type to `engine.worker.ts`
- Worker orchestrates the two-phase export: request → tick → take → postMessage
- Worker handles import: calls `import_world(json)` directly

### Phase 4: React Save/Load Wiring
- Save button in Toolbar, world name input
- Auto-save with 5-second debounce after edits
- Load on startup from IDB (last-opened world)
- World list UI (list all saved worlds, select, delete)
- Download world as JSON file
- Upload/import world from JSON file

### Phase 5: Level Persistence in IDB
- MapEditor saves/loads levels via IDB `levels` store
- Level browser in Freedom Board (list available levels for stamping)
- Fetch available maps from server (`/__list-files` endpoint) for seed levels

### Phase 6: Editor Persistence Migration
- TileEditor: save user tiles to IDB `assets` store
- CharacterEditor: save user characters to IDB `assets` store
- Both editors: load seed assets from CDN, user assets from IDB
- Download/upload individual tiles and characters

### Phase 7: App Unification
- Move freedom-board into `ui/web/` as a new route
- Both WASM crates loaded by their respective routes
- IDB shared across all routes
- Configurable home route

### Phase 8: Runtime Asset Loading (deferred)
- Dynamic atlas registration in zap-engine for user-created tiles
- User tiles appear in freedom-board with proper rendering
- Requires engine changes that don't exist yet

---

## Technical Debt Register

| Item | Phase | Severity | Description |
|------|-------|----------|-------------|
| UUID field contains tile name, not UUID4 | 2 | Medium | `serialize_world()` writes tile names like "iarba" in the `uuid` field. Correct for seed assets. Breaks when user-created assets arrive (Phase 8). Fix: implement proper intern table with UUID4 strings. |
| tileTypeToLayer() duplicated | N/A | Low | Exists in both InfiniteCanvas.tsx and App.tsx. Extract to shared utility when a third consumer appears. |
| Sorted-index convention still in use | 2 | Medium | React and WASM still agree on asset ordering via alphabetical sort. The UUID intern table refactor (Phase 8) will replace this with explicit UUID ↔ handle mapping. |
| No chunk-level serialization | 4 | High | Large worlds (10M+ tiles) will need chunk-level streaming rather than monolithic JSON. Current approach loads entire world into memory. WASM memory ceiling is ~4GB. |
| Auto-save not implemented | 4 | Medium | World state is only saved on explicit user action. Risk of data loss on browser crash. |
| SAB lock flag not checked | N/A | Medium | SharedArrayBuffer has HEADER_LOCK field but frame reader never checks it. Causes occasional tile glitches. Not storage-related but affects user experience during save/load transitions. |
| Base64 PNG in export | 6 | Low | ~33% overhead vs raw binary. Acceptable for current asset sizes. ZIP deferred. |
| No cross-device sync | 7+ | Low | Users must manually export/import between devices. Acceptable for single-user creative tool. |
| StorageGateway write path unused in user mode | 6 | Low | Once editors use IDB, the StorageGateway write path is only needed for curator/admin S3 uploads. Could add confusion. Document clearly. |

---

## Assumptions

1. IndexedDB is available in all target browsers (Chrome, Firefox, Safari, Edge). It is — IDB has been stable since 2015.
2. `navigator.storage.persist()` prevents eviction in most cases. Firefox requires explicit user permission; Chrome grants it automatically for installed PWAs and frequently visited sites.
3. World sizes remain under ~1M tiles for the foreseeable future. Monolithic JSON serialization handles this comfortably (<10MB JSON, <1 second serialize/deserialize).
4. Users have at most ~100 custom assets. IDB asset store scans are negligible at this scale.
5. The feather pipeline (`feather_atlases.py`) continues to run as a build step, not at runtime. Users create 128x128 tiles; the build system produces 160x160 feathered atlases.
