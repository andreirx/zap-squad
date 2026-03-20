# Freedom Board: Infinite Sparse Tile Canvas

## Purpose

Freedom Board is an infinite, sparse, chunk-based tile canvas that serves as both **world editor** and **game runtime**. Users place tiles to build worlds in edit mode, then flip to play mode where the same data structure drives gameplay. The Minecraft creative/survival duality, applied to a 2D tile engine.

It extends the existing zap-squad codebase without modifying existing code. All core logic is pure Rust, testable without WASM or a browser.

---

## Architecture Layers

```
+-------------------------------------------------------------------+
|                     CORE (Pure Rust, no deps)                     |
|  core/src/entities/freedom_board/                                 |
|    SparseWorld, Chunk, QuadTreeIndex, TilePlacement, TileCoord    |
|  core/src/use_cases/freedom_board/                                |
|    place_tile, erase_tile, flood_fill, query_viewport,            |
|    connectivity_bitmask, EditResult (undo/redo)                   |
+-------------------------------------------------------------------+
|                     INFRASTRUCTURE (Volatile)                     |
|  infrastructure/wasm-canvas/  (Rust, WASM)                        |
|    FreedomBoardGame: Game trait impl, event dispatch,             |
|    entity spawning, asset registry, camera state mirror           |
|  ui/canvas/  (React + TypeScript)                                 |
|    InfiniteCanvas, Toolbar, StatusBar, manifest loader            |
+-------------------------------------------------------------------+
```

Dependency direction: `ui/canvas/ --> wasm-canvas --> core/`. Core never imports from infrastructure.

There is no adapters layer for freedom-board currently. The WASM crate directly imports core entities and use cases. This is acceptable because freedom-board's "adapter" concerns (sprite mapping, event translation) are thin enough to live in the infrastructure layer without violating the dependency rule. If the adapter logic grows (e.g., Rhai scripting bridge, persistence gateway), it should be extracted.

---

## Core Entities

### TileCoord / ChunkCoord (`coords.rs`)

Two coordinate spaces:

| Type | Description | Range |
|------|-------------|-------|
| `TileCoord` | Individual cell on the infinite grid | `i32 x i32` |
| `ChunkCoord` | 32x32 tile block (storage unit) | `i32 x i32` |

Conversion uses **Euclidean division** (`div_euclid` / `rem_euclid`) to handle negative coordinates correctly:

```
tile (-1, 0)  --> chunk (-1, 0), local (31, 0)
tile (-32, 0) --> chunk (-1, 0), local (0, 0)
tile (-33, 0) --> chunk (-2, 0), local (31, 0)
```

Standard truncation division would produce `(-1) / 32 = 0` (wrong). Euclidean division produces `-1` (correct). This is the single most important implementation detail for negative-coordinate support.

**CHUNK_SIZE = 32**. This means `CHUNK_AREA = 1024` cells per chunk.

### TilePlacement (`tile_placement.rs`)

What occupies a single cell. Deliberately compact:

```
struct TilePlacement {    // 6 bytes (with u16 alignment padding)
    asset_id: u16,        // index into tile registry
    variant: u8,          // visual variation or connectivity bitmask
    layer: u8,            // render layer 0-5
    flags: u8,            // bitfield: flip_x(7), flip_y(6), rotation(5-4), reserved(3-0)
}
```

`Option<TilePlacement>` = **8 bytes**. A full chunk = `8 * 1024 = 8,192 bytes` = fits in L1 cache (32-64KB typical). This matters for neighbor lookups during transition calculations, which access adjacent cells in rapid succession.

The `flags` bitfield encodes transformations without separate fields:
- Bit 7: flip_x
- Bit 6: flip_y
- Bits 5-4: rotation (0=0, 1=90, 2=180, 3=270)
- Bits 3-0: reserved

### Chunk (`chunk.rs`)

A 32x32 block of `Option<TilePlacement>`. The fundamental storage unit.

```rust
struct Chunk {
    tiles: [Option<TilePlacement>; 1024],  // flat array, row-major
    tile_count: u16,                        // maintained on set/remove
    dirty: bool,                            // LOD recomputation flag
    lod: ChunkLOD,                          // cached level-of-detail summary
}
```

Key properties:
- **O(1) access**: `index = ly * 32 + lx`
- **Auto-cleanup**: When `tile_count` reaches 0, `SparseWorld` drops the chunk and removes it from the quadtree
- **Dirty tracking**: `dirty` flag set on every mutation, cleared after LOD recomputation
- **LOD cache**: `ChunkLOD` stores `dominant_color`, `density` (tiles/area), `top_layer` for far-zoom aggregate rendering

### QuadTreeIndex (`quad_index.rs`)

Spatial index over **chunk coordinates** (not individual tiles). Provides:
- O(log N) range queries for viewport culling
- Adaptive LOD aggregation for far-zoom rendering
- Dynamic growth to accommodate any coordinate

**Growth mechanism**: When a chunk is inserted outside current root bounds, the old root becomes a quadrant of a new, doubled root. The old root is placed in the quadrant **opposite** to where the target lies, so the tree expands toward the target. This repeats until the new coordinate fits.

```
Insert (100, 200) into tree rooted at (0,0):
  1. Root bounds: [0,0)x[1,1) -- doesn't contain (100,200)
  2. Target is east+south -> old root goes to NW (quadrant 0)
  3. New root bounds: [0,0)x[2,2) -- still doesn't contain
  4. Repeat until bounds contain (100,200)
```

**LOD query**: `query_lod(viewport, pixels_per_chunk, detail_threshold)` returns a mix of:
- `LODResult::Detail(ChunkCoord)` -- render individual tiles (close zoom)
- `LODResult::Aggregate { bounds, color, density }` -- render colored quad (far zoom)

The tree prunes entire subtrees when their screen-space size falls below `detail_threshold`.

**Node types**:
- `Leaf`: Single chunk coordinate with LOD data
- `Branch`: Four optional children (NW, NE, SW, SE) with aggregated stats

Aggregate colors are tile-count-weighted averages of child colors.

### SparseWorld (`sparse_world.rs`)

The central entity. Owns the primary storage and spatial index:

```rust
struct SparseWorld {
    chunks: HashMap<ChunkCoord, Chunk>,  // primary storage
    index: QuadTreeIndex,                 // spatial queries
    tile_count: u64,                      // global counter
    generation: u64,                      // mutation counter
}
```

**Generation counter**: Monotonically increasing. Bumped on every `set` or `remove`. The WASM renderer compares `generation` to its last-rendered value to skip redundant entity rebuilds. This is the change-detection mechanism.

**Chunk lifecycle**:
1. First tile in a new chunk region: `HashMap::insert` + `QuadTreeIndex::insert`
2. Tile operations within existing chunk: mutate chunk, `QuadTreeIndex::update_lod`
3. Last tile removed from chunk: `HashMap::remove` + `QuadTreeIndex::remove`

No empty chunks exist in memory.

---

## Use Cases

### Edit Operations (`world_edit.rs`)

Every mutation returns `EditResult { coord, old, new }` -- an invertible delta. Store these for undo/redo.

| Operation | Description | Notes |
|-----------|-------------|-------|
| `place_tile(world, coord, tile)` | Place single tile | Returns old occupant in EditResult |
| `erase_tile(world, coord)` | Remove single tile | No-op if empty (but still returns EditResult) |
| `fill_rect(world, min, max, tile)` | Fill rectangular region | Returns Vec<EditResult> |
| `erase_rect(world, min, max)` | Clear rectangular region | Only erases occupied cells |
| `draw_line(world, from, to, tile)` | Bresenham line rasterization | Continuous, no gaps |
| `flood_fill(world, start, tile, max)` | BFS flood fill | `max_tiles` safety limit prevents runaway on open space |

**Undo/Redo**: `EditResult::undo()` restores the old tile (or removes if old was None). `EditResult::redo()` re-applies the new tile. Operations that affect multiple tiles return `Vec<EditResult>` -- undo/redo by iterating in reverse/forward.

**Flood fill**: Uses 4-connected BFS. Fills cells matching the start cell's state (same tile or same emptiness). The `max_tiles` parameter is critical -- without it, filling empty space would attempt to fill the entire i32 coordinate space.

### Query Operations (`world_query.rs`)

Read-only. No mutations.

| Operation | Description | Use |
|-----------|-------------|-----|
| `query_viewport(world, min, max)` | All tiles in rectangle | Close-zoom rendering |
| `query_viewport_lod(world, min, max, zoom, base_px, threshold)` | Adaptive detail/aggregate | Far-zoom rendering |
| `get_chunk_tiles(world, chunk)` | All tiles from one chunk | Serialization, export |
| `count_tiles_in_rect(world, min, max)` | Count without allocation | Statistics |
| `connectivity_bitmask(world, coord)` | 4-bit neighbor mask | Transition sprite selection |
| `is_occupied(world, coord)` | Point query | Pathfinding, collision |
| `cardinal_neighbors(world, coord)` | N/E/S/W tile data | Transition calculations |

**Connectivity bitmask**: `N=8, S=4, W=2, E=1`. A bit is set if the neighbor exists **and has the same `asset_id`**. This drives automatic transition tile selection -- the bitmask maps directly to the existing atlas row system (base row + 8 directional transition rows per tile type).

---

## WASM Integration Layer

**Crate**: `infrastructure/wasm-canvas/` (Cargo package: `freedom-board-wasm`)

**Role**: Thin adapter between React UI and core SparseWorld. Implements zap-engine's `Game` trait. Contains **zero business logic**.

### FreedomBoardGame

```rust
struct FreedomBoardGame {
    // Core state
    world: SparseWorld,
    undo_stack: Vec<Vec<EditResult>>,
    redo_stack: Vec<Vec<EditResult>>,

    // Asset registry (u16 -> tile name for sprite lookup)
    tile_registry: Vec<TileAssetInfo>,

    // Camera (owned by React, mirrored here)
    camera_x: f32, camera_y: f32, zoom: f32,
    viewport_width: f32, viewport_height: f32,

    // Rendering state
    tile_entities: Vec<EntityId>,
    last_rendered_generation: u64,
    camera_dirty: bool,

    // Editor state
    active_asset_id: u16, active_layer: u8, active_variant: u8,
    tool: Tool,
}
```

### Game Trait Implementation

```
init()   -- check for pending tile registry, log startup
update() -- process custom events, rebuild entities if dirty, emit stats
render() -- no-op (engine draws spawned entities automatically)
```

The `update()` loop:
1. Check `PENDING_TILE_REGISTRY` thread-local for registry updates
2. Process all `InputEvent::Custom` from the input queue
3. If `generation` changed or `camera_dirty`, call `rebuild_visible_entities()`
4. Emit world stats to React if tile count changed

### Rendering Model

The engine renders entities in **screen-pixel coordinates**. WASM converts tile positions:

```
screen_x = (tile_x + 0.5 - camera_x) * zoom
screen_y = (tile_y + 0.5 - camera_y) * zoom
entity_scale = zoom (one tile = zoom pixels)
```

The `+0.5` centers the sprite on the tile cell.

`rebuild_visible_entities()`:
1. Despawn all current tile entities
2. Compute visible bounds from camera + viewport
3. `query_viewport()` on the SparseWorld
4. For each visible tile: `ctx.next_id()`, compute screen position, resolve sprite via `ctx.sprite("{tile_name}_{variant}")`, spawn entity

### Asset Registry

`TileAssetInfo { name: String, variations: u8 }` indexed by `asset_id` (u16).

Populated via `reload_game_manifest(json)` WASM export. This function:
1. Parses JSON array: `[{"name": "iarba", "variations": 3}, ...]`
2. Stores in `PENDING_TILE_REGISTRY` thread-local (because init may not have run yet)
3. The `update()` loop picks it up on next frame

The array index IS the asset_id. React and WASM must sort tiles identically (alphabetically by ID) to agree on numbering.

### Custom Event Protocol

#### React -> WASM (via `InputEvent::Custom { kind, a, b, c }`)

| kind | a | b | c | Description |
|------|---|---|---|-------------|
| 1 | tile_x (i32) | tile_y (i32) | asset_id (u16) | Place tile |
| 2 | tile_x (i32) | tile_y (i32) | layer (u8) | Erase tile |
| 3 | tool_id | -- | -- | Set active tool |
| 4 | asset_id | layer | variant | Set active tile |
| 100 | camera_x | camera_y | zoom (px/tile) | Camera state update |
| 101 | width_px | height_px | -- | Viewport resize |

#### WASM -> React (via `GameEvent { kind, a, b, c }`)

| kind | a | b | c | Description |
|------|---|---|---|-------------|
| 1 | tile_count | chunk_count | -- | World stats update |

Events travel through `f32` fields. Integer values (tile coords, IDs) are cast. This is safe for values up to 2^24 (16 million) -- the mantissa width of f32. Tile coordinates within ~8 million on either axis are exact. Beyond that, precision degrades. This is not a concern for practical map sizes.

### Tile Registry Transport

The registry doesn't use the custom event system. Instead:
1. React calls `sendEvent({ type: 'reload_game_manifest', json })` on the zap-engine hook
2. The engine worker recognizes this message type and calls the WASM `reload_game_manifest()` export
3. WASM parses JSON, stores in thread-local `PENDING_TILE_REGISTRY`
4. Next `update()` picks it up

This reuses existing zap-engine infrastructure without modification.

---

## UI Layer (React + TypeScript)

**Location**: `ui/canvas/`

### Components

| Component | Role |
|-----------|------|
| `App.tsx` | State container: tool, activeAssetId, worldStats, camera, tiles |
| `InfiniteCanvas.tsx` | Canvas host, camera control, input dispatch to WASM |
| `Toolbar.tsx` | Tool buttons (Pan/Draw/Erase/Fill), tile selector dropdown |
| `StatusBar.tsx` | Cursor coords, camera state, world stats |

### InfiniteCanvas

Owns camera state as a `useRef` (not React state -- avoids re-renders on every mouse move):

```typescript
cameraRef = { x: -5, y: -5, zoom: 64 }  // top-left of viewport in tile coords
```

**Camera model**:
- `camera_x, camera_y`: top-left of viewport in tile coordinates (floats)
- `zoom`: pixels per tile on screen. Default 64 = each tile is 64x64 CSS pixels

**Screen-to-tile conversion**:
```
tileX = floor(screenX / zoom + cameraX)
tileY = floor(screenY / zoom + cameraY)
```

**Zoom**: Scroll wheel, centered on cursor position. The math inverts the screen-to-tile transform to keep the cursor's tile position stable:
```
tileAtCursor = screenPos / oldZoom + camera
newCamera = tileAtCursor - screenPos / newZoom
```

**Pan**: Middle-mouse drag, or left-drag when tool=pan.

**Draw/Erase**: Left-click sends `PLACE_TILE`/`ERASE_TILE` events. During drag, only fires when the cursor enters a new tile cell (deduplication via `lastTileX/lastTileY`).

### Manifest Loading (`lib/manifest.ts`)

`loadTileManifest()`:
1. Fetches `{ASSETS_URL}/manifest.json`
2. Extracts tile entries, sorts alphabetically by ID
3. Returns `TileDefinition[]` (full metadata for UI) and `TileRegistryEntry[]` (minimal data for WASM)

The alphabetical sort is the deterministic ordering contract. Both React and WASM must use it. If a new tile is added to the manifest, all asset_ids may shift. This is acceptable for an editor where the registry is rebuilt on startup. Serialized maps should store tile names, not asset_ids, for persistence stability.

### Asset URL Configuration

```typescript
// ui/canvas/src/config.ts
export const ASSETS_URL = import.meta.env.VITE_ASSETS_URL || '/assets';
```

| Environment | VITE_ASSETS_URL | Mechanism |
|-------------|-----------------|-----------|
| Local dev | `/assets` (default) | Vite middleware proxies to `ui/web/public/assets/` |
| Production | CloudFront URL | Direct CDN fetch |

The Vite dev server includes a `localAssetsPlugin()` middleware that maps `/assets/*` requests to the sibling `ui/web/public/assets/` directory. Includes path traversal protection (`path.normalize` + prefix check) and `Cross-Origin-Resource-Policy: cross-origin` header for CORS.

Assets are **never copied**. They stay in `ui/web/public/assets/` (the single source of truth) and are referenced by URL.

---

## Rendering Pipeline (End to End)

```
1. React loads manifest.json        -->  tiles[] + registry[]
2. React sends registry to WASM     -->  reload_game_manifest(json)
3. React sends camera + viewport    -->  CAMERA_UPDATE, VIEWPORT_SIZE events
4. User clicks/drags                -->  PLACE_TILE / ERASE_TILE events
5. WASM update():
   a. Process custom events         -->  mutate SparseWorld
   b. query_viewport()              -->  Vec<VisibleTile>
   c. For each tile:
      - Resolve asset_id -> name    -->  tile_registry[asset_id].name
      - Build sprite key            -->  "{name}_{variant}"
      - ctx.sprite(&key)            -->  SpriteComponent from engine
      - Compute screen position     -->  (tile + 0.5 - camera) * zoom
      - Spawn Entity                -->  engine scene
6. Engine serializes entities        -->  RenderInstance (8 floats per instance)
7. SharedArrayBuffer transfer        -->  JS renderer thread
8. JS renderer draws quads           -->  Canvas2D (or WebGPU when texture issue fixed)
```

Sprite naming convention: `{tile_name}_{index}` where index is typically the variation number (0-based). The engine looks up the sprite in `assets.json` which maps names to atlas coordinates.

**Currently using Canvas2D** (`force2D: true`) due to WebGPU texture size limitation. See MEMORY.md for details. When fixed, remove `force2D` flag.

---

## Layer System

| Layer | Value | RenderLayer Enum | Typical Contents |
|-------|-------|------------------|------------------|
| Background | 0 | `Background` | Base terrain (land, water) |
| Terrain | 1 | `Terrain` | Transition tiles |
| Objects | 2 | `Objects` | Rivers (water paths) |
| Foreground | 3 | `Foreground` | Bridges |
| VFX | 4 | `VFX` | Ground paths |
| UI | 5 | `UI` | Characters, selection |

Layer is stored in `TilePlacement.layer` (u8). The WASM crate maps 0-5 to zap-engine's `RenderLayer` enum. Values > 5 default to `RenderLayer::UI`.

---

## Build Commands

```bash
make wasm-canvas    # Build WASM: wasm-pack -> ui/canvas/src/wasm/
make dev-canvas     # Build WASM + start Vite dev server (port 5179)
make test           # Run all Rust tests (including freedom-board core)
make check          # Cargo check all targets
```

**Dev server details**:
- Port: 5179
- COOP/COEP headers enabled (required for SharedArrayBuffer)
- WASM plugin + top-level-await plugin for WASM imports
- Local assets served from `ui/web/public/assets/`

---

## Test Coverage

All core logic has tests that run on the host machine (`cargo test`), with no WASM or browser required.

| Module | Test Count | What's Tested |
|--------|-----------|---------------|
| `coords.rs` | 7 | Positive/negative tile->chunk, local coords, roundtrip |
| `tile_placement.rs` | 7 | Size compactness, flag bitfield operations |
| `chunk.rs` | 9 | Set/get/remove, dirty flag, density, bounds |
| `quad_index.rs` | 13 | Insert/remove, growth, range query, LOD query, stress |
| `sparse_world.rs` | 11 | CRUD, negative coords, chunk lifecycle, generation, bounds |
| `world_edit.rs` | 9 | Place/erase, undo/redo, fill_rect, Bresenham, flood_fill |
| `world_query.rs` | 5 | Viewport query, connectivity bitmask, count |

Total: **61 tests** covering core entities and use cases.

---

## Maturity Level

**PROTOTYPE**

### What Works
- Full CRUD on infinite sparse grid with correct negative coordinates
- Quadtree spatial indexing with dynamic growth
- LOD aggregation infrastructure in core (not yet wired to WASM)
- Complete undo/redo delta system
- WASM rendering via zap-engine entity spawning
- Camera pan/zoom with cursor-centered zoom
- Tile registry transport from React to WASM
- Environment-based asset URL configuration

### Known Technical Debt

| Item | Severity | Description |
|------|----------|-------------|
| **Entity pooling** | Medium | `rebuild_visible_entities()` does full despawn/respawn every frame the world or camera changes. Acceptable for <10K visible tiles. Beyond that, need diff-based spawning. |
| **LOD rendering not wired** | Low | `query_viewport_lod()` exists in core and quadtree supports it, but WASM always uses `query_viewport()`. Wire when infinite zoom-out is needed. |
| **Undo stack unbounded** | Medium | `Vec<Vec<EditResult>>` grows without limit. Need max depth (e.g., 1000 operations) with tail truncation. |
| **No persistence** | High | World state is in-memory only. Need serialization to/from JSON or binary format. Design decision required: chunk-level files? Single world file? |
| **No Rhai scripting** | High | Play mode not implemented. SparseWorld is ready to be read/mutated by scripts but the scripting bridge doesn't exist yet. |
| **f32 event precision** | Low | Tile coordinates and asset IDs travel as f32 in the custom event protocol. Safe up to 2^24 (~16M). Not a concern for practical use but worth documenting. |
| **Deterministic registry ordering** | Medium | Alphabetical sort of tile IDs for asset_id assignment means adding a tile can shift all IDs. Serialized maps must store tile names, not IDs. |
| **Force2D rendering** | Low | Using Canvas2D fallback due to WebGPU texture size limit. Fix: request `maxTextureDimension2D: 16384` in `requestDevice()`. |
| **No transition auto-computation** | Medium | `connectivity_bitmask()` exists in core but the WASM layer doesn't auto-compute transitions on tile placement. Current behavior: tiles render base variation only. |
| **Fill tool incomplete** | Low | UI sends `PLACE_TILE` for fill. Should trigger `flood_fill()` use case instead. Requires adding a new custom event kind or changing fill behavior in WASM. |

### Assumptions

1. Tile atlas layout follows the existing convention: N columns (variations) x 9 rows (base + 8 directional transitions).
2. Sprite names in `assets.json` follow `{tile_id}_{index}` format.
3. The zap-engine worker dispatches `reload_game_manifest` messages to the WASM export of the same name.
4. SharedArrayBuffer is available (COOP/COEP headers configured).
5. The manifest.json format matches what `bake-atlases` produces.

### Divergences from Original Plan

1. **No adapters layer**: The WASM crate imports core directly. If Rhai scripting or persistence gateways are added, an adapters layer should be introduced.
2. **Camera owned by React**: Originally considered WASM-owned camera. React-owned was chosen because the infinite canvas pan/zoom is a UI concern, and React already handles pointer events natively.
3. **Single-layer tiles**: TilePlacement supports multi-layer (0-5) but the current UI only places on layer 0. Multi-layer editing is a future feature.

---

## File Index

```
core/src/entities/freedom_board/
  mod.rs              # Module declarations and public re-exports
  coords.rs           # TileCoord, ChunkCoord, CHUNK_SIZE, Euclidean division
  tile_placement.rs   # TilePlacement (6-byte compact struct with flags bitfield)
  chunk.rs            # Chunk (32x32 storage), ChunkLOD, dirty tracking
  quad_index.rs       # QuadTreeIndex, ChunkAABB, LODResult, NodeAggregate
  sparse_world.rs     # SparseWorld (HashMap + QuadTree), VisibleTile

core/src/use_cases/freedom_board/
  mod.rs              # Module declarations and re-exports
  world_edit.rs       # EditResult, place/erase/fill/line/flood_fill
  world_query.rs      # query_viewport, connectivity_bitmask, count, neighbors

infrastructure/wasm-canvas/
  Cargo.toml          # Crate config: cdylib + rlib
  src/lib.rs          # FreedomBoardGame, Game trait impl, WASM exports
  MAP.md              # Architecture role and data flow

ui/canvas/
  package.json        # React app: freedom-board
  vite.config.ts      # Port 5179, COOP/COEP, WASM plugin, asset proxy
  index.html          # Full-viewport dark shell
  .env / .env.example # VITE_ASSETS_URL configuration
  src/
    config.ts         # ASSETS_URL from env
    App.tsx           # State container, manifest loading
    lib/manifest.ts   # loadTileManifest(), deterministic tile ordering
    components/
      InfiniteCanvas.tsx  # Camera, input, zap-engine hook, event dispatch
      Toolbar.tsx         # Tool buttons, tile selector
      StatusBar.tsx       # Cursor, camera, stats display
```
