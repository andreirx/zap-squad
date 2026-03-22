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
| IDB module (TS) | DONE | `ui/canvas/src/lib/idb.ts` |
| SparseWorld::iter_all() | DONE | `core/src/entities/freedom_board/sparse_world.rs` |
| SparseWorld::clear() | DONE | `core/src/entities/freedom_board/sparse_world.rs` |
| WASM serialize_world() | DONE | `infrastructure/wasm-canvas/src/lib.rs` |
| WASM import_world_from_json() | DONE | `infrastructure/wasm-canvas/src/lib.rs` |
| WASM exports (request/take/import) | DONE | `infrastructure/wasm-canvas/src/lib.rs` |
| Engine worker bridge | PENDING | `@zap/web engine.worker.ts` |
| React save/load UI | PENDING | `ui/canvas/` |

## Technical Debt Created
- tileTypeToLayer() is duplicated in InfiniteCanvas.tsx and App.tsx. Extract to shared utility when a third consumer appears.
- The sorted-index convention removal means React's tileRegistry array is no longer the source of truth for handle assignment. React only needs UUIDs for display and file parsing.
- The `uuid` field in serialized world data currently contains tile name strings ("iarba"), not true UUID4. Correct for seed assets; will break when user-created assets arrive. Fix at Phase 8.

---

# ADR: App Unification — Freedom Board as Primary Route

## Status: Accepted (2026-03-22)

## Context

The project has two separate React applications:
- `ui/web/` — main app with editors (tile, character, map) and legacy game pages
- `ui/canvas/` — standalone freedom-board app

Running two separate apps creates friction: no shared IDB database, no shared routing, no shared asset registry. Users cannot navigate between editors and the freedom board without switching browser tabs/ports.

The freedom-board is the primary development focus and the vehicle for achieving the full vision (Rhai scripting, combat, movement). The editors are supporting tools.

## Decision

### 1. Freedom-board becomes a route in ui/web

Freedom-board will be added as a route in the existing `ui/web/` React Router configuration, alongside the editors. It is NOT a separate application.

### 2. Route ordering is configurable

The home route (`/`) can be mapped to any page. Currently intended to be freedom-board. Changing which page is home is a one-line route configuration change.

### 3. Both WASM crates coexist

The existing game WASM crate (`zapsquad-wasm`, used by `/game/wasm`) and the freedom-board WASM crate (`freedom-board-wasm`) are separate packages. Each route loads its own WASM module. They share the same Rust core library.

### 4. IDB is the shared state layer

All routes (editors + freedom-board) read and write the same "zapsquad" IndexedDB database. An asset created in the Tile Editor is immediately available in the Freedom Board's registry.

### 5. Editors stay on 128x128 source sprites

The tile, character, and map editors work with raw 128x128 source PNGs. They do NOT use feathered 160x160 atlases. The feathering pipeline (`feather_atlases.py`) is a build step between editor output and freedom-board input.

This means:
- Editors show raw tile edges (correct for authoring)
- Freedom-board shows feathered edges (correct for gameplay)
- No editor code changes needed for feathering

### 6. Legacy game page retained

The existing `/game/wasm` route (WasmGamePage) is kept but not actively developed. It will be deleted when freedom-board achieves full feature parity with the old renderer. Until then, it serves as reference for features that need to be ported.

## Consequences

- `ui/canvas/` can be progressively merged into `ui/web/` or kept as a dev-only standalone
- All persistence goes through the shared IDB — no data silos
- Users navigate between editors and freedom-board seamlessly
- Adding new tool pages (e.g., weapon editor, script editor) follows the same pattern
- The two WASM crate builds add ~2 seconds to CI, but only the actively-used crate is loaded per route
