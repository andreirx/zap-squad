# Architectural Decision Records

This file logs significant architectural decisions for the ZapSquad project.

---

# ADR: Asset Identity and Persistence Architecture

## Status: Accepted (2026-03-22)

## Context

The freedom-board infinite canvas editor and all ZapSquad editors (tile, character, map) need persistent storage. The deployment model is a static site with seed assets on S3 and no backend server. Users must be able to create custom assets, persist their work across sessions, and download/upload individual assets, levels, and worlds.

The previous design used positional u16 indices into an alphabetically-sorted asset array as the primary identity for tiles. This is fragile: adding or removing assets shifts indices, corrupting any saved data that references them. This was identified as a fundamental flaw when persistence requirements emerged.

## Decision

### 1. UUID-Based Asset Identity

Every asset (tile, character, weapon) is identified by a permanent unique string. Seed assets use their existing human-readable IDs ("iarba", "carnat_test"). User-created assets use UUID4 strings. The system treats both identically.

This identifier is what gets persisted — in IndexedDB, in downloaded files, in LDtk levels, in world saves. Never a positional index.

### 2. Runtime Interning (u16 Handles)

The in-memory TilePlacement struct remains compact at 6 bytes. The u16 asset_id field becomes a session-local interned handle, assigned at runtime, never persisted. A bidirectional intern table (HashMap<String, u16> forward, Vec<String> reverse) maps between UUIDs and handles.

This is standard string interning — the same pattern used in compilers, game engines, and database query engines.

### 3. IndexedDB for Browser Persistence

All editors share a single IndexedDB database ("zapsquad") with four object stores:

- "assets" — key: UUID string, value: { type, source ("seed"|"user"), metadata, blob (ArrayBuffer|null for seed), updatedAt }
- "levels" — key: level name, value: { ldtk (LDtk JSON), updatedAt }
- "worlds" — key: world name, value: { version, tiles (UUID-based), characters, camera, updatedAt }
- "config" — key: string, value: any

IndexedDB was chosen over localStorage because:
- Accessible from Web Workers (where WASM runs) — no cross-thread boundary issue
- 50MB+ storage limit vs localStorage's 5MB
- Supports binary data (ArrayBuffer) natively — no base64 encoding needed for PNG blobs
- Transactional guarantees

### 4. Two-Tier Asset Model

Seed assets are served from S3/static hosting. User assets are stored in IndexedDB. At startup, both sources merge into a unified runtime registry. The engine doesn't care about the source.

Seed assets have source="seed" and blob=null in IDB (the PNG is loaded from S3). User assets have source="user" with the actual PNG blob stored in IDB.

### 5. File Export/Import

Every piece of user data is downloadable and uploadable:
- Tile/character assets: JSON file containing metadata + base64-encoded PNG
- Levels: LDtk JSON (existing format, unchanged)
- Worlds: JSON with UUID-referenced tiles + characters + camera state
- Full backup: single JSON containing all of the above (ZIP support deferred)

### 6. Serialization Format (World)

The world serialization format uses UUID strings, never interned handles:

```json
{
  "version": 1,
  "tiles": [
    { "x": 5, "y": 3, "uuid": "iarba", "variant": 2, "layer": 0, "flags": 0 }
  ],
  "characters": [
    { "x": 5.5, "y": 3.5, "bodyDefId": "carnat_test", "direction": "south", "health": 100, "maxHealth": 100 }
  ],
  "camera": { "x": -5, "y": -5, "zoom": 64 }
}
```

On import, UUIDs are resolved to current runtime handles via the intern table. Missing assets are skipped with a warning logged.

## Consequences

### What Changes
- The alphabetically-sorted index convention between React and WASM is eliminated
- reload_game_manifest sends UUIDs explicitly; WASM builds its own intern table
- React no longer needs to know or agree on handle values
- TilePlacement struct is unchanged (u16 + u8s); only the semantics of the u16 change
- SparseWorld needs an iter_all() method for serialization (walk all occupied cells)
- New WASM exports: export_world_json() and import via load_level with UUID resolution

### What Stays the Same
- TilePlacement memory layout (6 bytes, cache-friendly)
- Core algorithms (place_tile, flood_fill, stamp_tiles, connectivity_bitmask)
- Entity/sprite rendering pipeline
- LDtk level format (already uses asset name strings)

### Phased Implementation
1. UUID intern table + world persistence (IDB + download/upload) — seed assets only
2. Level persistence in IDB
3. Shared IDB infrastructure across editors
4. Runtime asset loading in engine (dynamic atlas registration)
5. User-created assets in IDB + download/upload

See `docs/storage-architecture.md` for the detailed 8-phase plan with current implementation status.

### Risks
- IndexedDB can be evicted by the browser under storage pressure. Mitigation: request navigator.storage.persist() and warn users to download backups.
- Runtime asset loading (Phase 4) requires engine changes that don't exist yet.
- Base64 PNG in JSON export is ~33% larger than raw binary. Acceptable for sprite sheets (<500KB). ZIP support deferred.

## Implementation Status (updated 2026-03-22)

| Component | Status | Location |
|-----------|--------|----------|
| IDB module (TS) | DONE | `ui/web/src/lib/idb.ts` (shared, v2 with files store) |
| IdbStorage (StorageGateway) | DONE | `ui/web/src/storage/IdbStorage.ts` |
| SparseWorld::iter_all() | DONE | `core/src/entities/freedom_board/sparse_world.rs` |
| SparseWorld::clear() | DONE | `core/src/entities/freedom_board/sparse_world.rs` |
| WASM serialize_world() | DONE | `infrastructure/wasm-canvas/src/lib.rs` |
| WASM import_world_from_json() | DONE | `infrastructure/wasm-canvas/src/lib.rs` |
| WASM exports (request/take/import) | DONE | `infrastructure/wasm-canvas/src/lib.rs` |
| Engine worker bridge | DONE | `@zap/web engine.worker.ts` (export_world, import_world messages) |
| React save/load UI | DONE | `ui/web/src/freedom-board/` (Save/Load buttons, auto-save) |
| Freedom-board in unified app | DONE | `ui/web/src/freedom-board/FreedomBoardPage.tsx` (home route) |
| Settings persistence | DONE | Debug flags + SAB lock in IDB config store |
| Feathering WASM crate | DONE | `infrastructure/wasm-feather/` (10 tests passing) |
| Character smooth movement | DONE | `infrastructure/wasm-canvas/` (interpolation, no more teleport) |
| Persistent storage request | DONE | `ui/web/src/main.tsx` calls `requestPersistentStorage()` |
| IDB version migration handler | DONE | Sequential `if (oldVersion < N)` chain in `idb.ts` |

## Technical Debt Created
- The sorted-index convention still in use. React and WASM agree on asset ordering via alphabetical sort. Phase 8 replaces with explicit UUID-to-handle mapping.
- The `uuid` field in serialized world data currently contains tile name strings ("iarba"), not true UUID4. Correct for seed assets; will break when user-created assets arrive. Fix at Phase 8.
- Character movement uses fixed dt of 1/60s. Should use actual frame delta from the engine when available.
- Feathering WASM crate (`wasm-feather`) is built and tested but not yet wired into the app. Freedom-board still reads pre-baked feathered PNGs. Wiring is Phase 7 completion.

---

# ADR: App Unification — Freedom Board as Primary Route

## Status: Implemented (2026-03-23)

## Context

The project had two separate React applications:
- `ui/web/` — main app with editors and legacy game pages
- `ui/canvas/` — standalone freedom-board prototype

Running two separate apps creates friction: no shared IDB database, no shared routing, no shared asset registry. Users cannot navigate between editors and the freedom board without switching browser tabs/ports.

The freedom-board is the primary development focus and the vehicle for achieving the full vision (Rhai scripting, combat, movement). The editors are supporting tools.

## Decision

### 1. Freedom-board components integrated into ui/web

Freedom-board components (InfiniteCanvas, DebugPanel, AssetPanel, StatusBar, FBToolbar) were copied into `ui/web/src/freedom-board/` and adapted to work within the existing app's routing and shared libraries.

`ui/canvas/` is retained as the original prototype reference. It is not actively developed — all new work happens in `ui/web/`.

### 2. Route structure

```
/                     → Freedom Board (home)
/editor/tile          → Tile Editor
/editor/character     → Character Editor
/editor/map           → Map Editor
/editor/object        → Object Editor
/game/*               → Legacy reference surfaces, not part of the main navigation
```

The home route (`/`) is freedom-board. Changing which page is home is a route configuration change in App.tsx.

### 3. Both WASM crates coexist

The existing game WASM crate (`zapsquad-wasm`, used by `/game/wasm`) and the freedom-board WASM crate (`freedom-board-wasm`) are separate packages in `ui/web/src/wasm/`. Each route loads its own WASM module. They share the same Rust core library. `make wasm-canvas` builds and copies to both `ui/canvas/` and `ui/web/`.

### 4. IDB is the shared state layer

All routes (editors + freedom-board) share the same "zapsquad" IndexedDB database. Shared modules:
- `ui/web/src/lib/idb.ts` — IndexedDB CRUD, world/level/asset/config stores
- `ui/web/src/lib/config.ts` — ASSETS_URL configuration

### 5. Editors stay on 128x128 source sprites

The tile, character, and map editors work with raw 128x128 source PNGs. They do NOT use feathered 160x160 atlases. The feathering pipeline is NOT system-wide — it will be ported from Python to a dedicated WASM crate (`infrastructure/wasm-feather/`) that runs client-side as an intermediate bake step before freedom-board renders. Editors never see feathered tiles.

### 6. Save/load to disk

Freedom-board toolbar has explicit Save (download JSON) and Load (upload JSON → IDB → reload) buttons. Auto-save to IDB continues as before with 2-second debounce.

### 7. Settings persistence

Debug panel state (grid, crosshair, quadtree toggles, SAB lock) persists in IDB `config` store under `freedom-board.*` keys. Loaded on mount, saved on change.

### 8. Legacy game pages de-emphasized

Legacy game pages may still exist in the repository, but they are no longer exposed as primary navigation in the main app shell. Freedom Board is the product-facing route.

## Consequences

- `ui/canvas/` remains as prototype reference, untouched
- All persistence goes through the shared IDB — no data silos
- Users navigate between editors and freedom-board seamlessly
- Adding new tool pages follows the same pattern (route + component)
- The two WASM crate builds add ~2 seconds to CI, but only the actively-used crate is loaded per route
- Editors still use StorageGateway-style reads for seed content while converging on IDB-backed persistence

---

# ADR: Path Connectivity Semantics and Asset Simplification

## Status: Accepted (implementation in progress, 2026-03-23)

## Context

The original path system treated all path connectivity as type-strict: a path only connected to adjacent paths with the same asset identity. This works for rivers, but it is too rigid for roads and other land-based paths once terrain blending is smooth and path art styles are allowed to vary.

At the same time, the content model is being simplified: weapons and ranged/throwable visuals are converging toward a simpler object-centric visual asset model rather than separate parallel content categories.

## Decision

### 1. Asymmetric path connectivity

- `PATH + WATER` remains strict: water paths only connect to adjacent water paths of the same type.
- `PATH + LAND` becomes network-oriented: land paths connect across different land-path asset types.

This is a semantic rule, not merely a renderer trick. Roads are treated as one traversable network even when their art variants differ. Rivers remain type-distinct.

### 2. Bridge connectivity follows the effective land-path network

Bridges continue to be derived from land paths crossing water, but their connectivity should follow the visible land-path network rather than the old same-type-only road rule.

### 3. Object asset simplification

The product direction is toward a simplified visual asset model where ranged/throwable visuals are represented through object assets with idle frames, reducing category overlap and making attack presentation easier to reason about in the runtime.

## Consequences

- Map Editor and Freedom Board must share the same asymmetric path rule
- Data schemas and docs must stop describing land paths as same-type-only
- Bridge rendering logic must be validated against mixed road types
- Combat feature work can rely on object assets for ranged/throwable presentation without preserving a separate user-facing weapon editor concept as a primary surface
