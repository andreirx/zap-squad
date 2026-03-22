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

## App Unification — Implemented

### Current State (as of 2026-03-22)

Single React app (`ui/web/`) with freedom-board as the home route. `ui/canvas/` retained as prototype reference, not actively developed.

```
/                     → Freedom Board (home)
/editor/tile          → Tile Editor
/editor/character     → Character Editor
/editor/map           → Map Editor
/editor/object        → Object Editor
/editor/weapon        → Weapon Editor
/game/canvas2d        → Legacy Canvas2D game page (retained)
/game/wasm            → Legacy WebGPU game page (retained)
```

### Key Facts

1. **Freedom-board is the primary focus.** It is the vehicle for Rhai scripting, combat, movement — the full game runtime. Editors are supporting tools.

2. **Editors stay on 128x128 source sprites.** They do NOT use feathered 160x160 atlases. The feathering pipeline is NOT system-wide. It will be ported from Python to a WASM crate that runs client-side as an intermediate bake step. Editors never see feathered tiles.

3. **Freedom-board uses baked 160x160 feathered sheets.** Currently produced by `feather_atlases.py`. Future: produced by `infrastructure/wasm-feather/` crate running in-browser.

4. **Both WASM crates coexist** in `ui/web/src/wasm/`. `make wasm-canvas` builds and copies to both `ui/canvas/` and `ui/web/`.

5. **IDB is the shared state layer.** Shared modules at `ui/web/src/lib/idb.ts` and `ui/web/src/lib/config.ts`.

6. **Save/load to disk.** Freedom-board toolbar has explicit Save (download JSON) and Load (upload JSON) buttons. Auto-save to IDB continues with 2-second debounce.

7. **Settings persistence.** Debug panel state persists in IDB `config` store under `freedom-board.*` keys.

8. **Editors still use StorageGateway** for read/write (LocalStorage in dev, S3 in prod). IDB migration for editor persistence is next phase.

---

## Phased Implementation Plan

### Phase 1: IDB Module (DONE)
- `ui/web/src/lib/idb.ts` — generic CRUD over IndexedDB (shared across all routes)
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

### Phase 3: Engine Worker Bridge (DONE)
- `export_world` and `import_world` message types in engine worker
- Worker orchestrates the two-phase export: request → tick → take → postMessage
- Worker handles import: calls `import_world(json)` directly

### Phase 4: React Save/Load Wiring (DONE)
- Save/Load buttons in FBToolbar (download JSON / upload JSON)
- Auto-save with 2-second debounce after edits
- Load on startup from IDB (autosave key)
- Download world as timestamped JSON file
- Upload world JSON → save to IDB → reload

### Phase 5: App Unification (DONE)
- Freedom-board components integrated into `ui/web/src/freedom-board/`
- Home route (`/`) is freedom-board
- Navigation bar across all routes
- Both WASM crates in `ui/web/src/wasm/`
- IDB shared across all routes via `ui/web/src/lib/idb.ts`
- Settings persistence via configStore (debug flags, SAB lock)
- `ui/canvas/` retained as prototype reference

### Phase 6: Editor Persistence Migration (next)
- TileEditor: save user tiles to IDB `assets` store
- CharacterEditor: save user characters to IDB `assets` store
- MapEditor: save levels to IDB `levels` store
- All editors: load seed assets from CDN, user assets from IDB
- Download/upload individual tiles, characters, levels

### Phase 7: Feathering WASM Crate (planned)
- New `infrastructure/wasm-feather/` Rust crate
- Takes 128x128 atlas PNG bytes + feather params → outputs 160x160 feathered RGBA
- Runs client-side in browser (Web Worker or main thread)
- Result cached in IDB or in-memory
- Replaces `feather_atlases.py` for deployed product

### Phase 8: Runtime Asset Loading (deferred)
- Dynamic atlas registration in zap-engine for user-created tiles
- User tiles appear in freedom-board with proper rendering
- Requires engine changes that don't exist yet

---

## Technical Debt Register

| Item | Phase | Severity | Description |
|------|-------|----------|-------------|
| UUID field contains tile name, not UUID4 | 2 | Medium | `serialize_world()` writes tile names like "iarba" in the `uuid` field. Correct for seed assets. Breaks when user-created assets arrive (Phase 8). Fix: implement proper intern table with UUID4 strings. |
| tileTypeToLayer() duplicated | N/A | Low | Exists in InfiniteCanvas.tsx (exported) and FreedomBoardPage.tsx (imports it). Consolidated. |
| Sorted-index convention still in use | 2 | Medium | React and WASM still agree on asset ordering via alphabetical sort. The UUID intern table refactor (Phase 8) will replace this with explicit UUID ↔ handle mapping. |
| No chunk-level serialization | 4 | High | Large worlds (10M+ tiles) will need chunk-level streaming rather than monolithic JSON. Current approach loads entire world into memory. WASM memory ceiling is ~4GB. |
| Auto-save implemented | 4 | RESOLVED | Auto-save with 2-second debounce. Save suppressed for 5 seconds after load to prevent re-save loops. |
| SAB lock wired | N/A | RESOLVED | zap-engine's useZapEngine hook checks Atomics.load(i32, 0) when useSabLock=true. Toggle in debug panel persists to IDB. Lock prevents tearing; without lock, frames may tear but render every rAF. |
| Base64 PNG in export | 6 | Low | ~33% overhead vs raw binary. Acceptable for current asset sizes. ZIP deferred. |
| No cross-device sync | 7+ | Low | Users must manually export/import between devices. Acceptable for single-user creative tool. |
| StorageGateway write path unused in user mode | 6 | Low | Once editors use IDB, the StorageGateway write path is only needed for curator/admin S3 uploads. Could add confusion. Document clearly. |

---

## Assumptions

1. IndexedDB is available in all target browsers (Chrome, Firefox, Safari, Edge). It is — IDB has been stable since 2015.
2. `navigator.storage.persist()` prevents eviction in most cases. Firefox requires explicit user permission; Chrome grants it automatically for installed PWAs and frequently visited sites.
3. World sizes remain under ~1M tiles for the foreseeable future. Monolithic JSON serialization handles this comfortably (<10MB JSON, <1 second serialize/deserialize).
4. Users have at most ~100 custom assets. IDB asset store scans are negligible at this scale.
5. The feather pipeline currently runs as a Python build step (`feather_atlases.py`). It will be ported to a WASM crate (`infrastructure/wasm-feather/`) that runs client-side. Users create 128x128 tiles; the WASM module produces 160x160 feathered atlases in-browser.
6. Load-from-disk currently requires a page reload after importing world JSON to IDB. A future improvement would send `import_world` directly to the WASM worker without reloading.
