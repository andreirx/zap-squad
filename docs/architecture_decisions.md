# Architecture Decisions

## ADR-001: Clean Architecture Foundation
**Date:** 2026-02-11
**Status:** Accepted

### Context
ZapSquad is designed to be a high-reliability game engine for educational use.

### Decision
Adopt Clean Architecture with strict layer separation:
- core/ contains pure business logic (no framework deps)
- adapters/ bridges core to external systems
- infrastructure/ contains volatile external details

### Consequences
- Core logic fully testable without WASM/browser
- zap-engine is an implementation detail, swappable
- Slightly more boilerplate for boundary crossing

---

## ADR-002: zap-engine as Rendering Backend
**Date:** 2026-02-11
**Status:** Accepted

### Context
Need WebGPU rendering with HDR support.

### Decision
Use zap-engine via adapter layer, not direct integration.

### Consequences
- Rendering is isolated behind EngineGateway
- Core doesn't know about sprites, shaders, etc.
- Future: could swap for native Metal/Vulkan backend

---

## ADR-003: Rhai for Scripting
**Date:** 2026-02-11
**Status:** Accepted

### Context
Kids need a simple, safe scripting language.

### Decision
Use Rhai (Rust-native, WASM-compatible, sandboxed).

### Consequences
- Simple syntax accessible to beginners
- No filesystem/network access (safe sandbox)
- Script execution happens in adapters layer

---

## ADR-004: Separate Editor and Game Deployments
**Date:** 2026-02-20
**Status:** Superseded

> Superseded by the unified application direction centered on Freedom Board.
> See `docs/DECISIONS.md` and `docs/ARCHITECTURE.md` for the current architecture.

### Context
The editor requires authentication (Cognito) for asset creation and storage.
The game should be freely accessible without authentication.
These have different security requirements and deployment lifecycles.

This ADR has been superseded by the unified-app direction centered on Freedom Board. It is preserved here as project history.

### Decision
Split into two separate deployable applications:

```
zap-squad/
├── core/                    # Rust - pure game logic (NO rendering)
│   └── src/
│       ├── entities/        # Actor, Weapon, Tile, GameState
│       └── use_cases/       # Combat, Movement, AI
│
├── adapters/                # Rust - bridges core to infrastructure
│   └── src/
│       ├── script_engine/   # Rhai integration
│       ├── renderer/        # zap-engine integration
│       └── asset_loader/    # Load JSON definitions
│
├── editor/                  # SEPARATE DEPLOY - WITH Cognito auth
│   └── web/
│       ├── src/
│       │   ├── editors/     # Character, Weapon, Tile, Map editors
│       │   └── storage/     # S3Storage with Cognito auth
│       └── package.json
│
├── game/                    # SEPARATE DEPLOY - NO auth
│   ├── web/                 # Minimal React for config/scripting UI
│   │   └── src/
│   │       ├── GameCanvas   # WASM renders game here
│   │       ├── ConfigPanel  # Live game parameter tweaking
│   │       ├── ScriptPanel  # In-browser Rhai editing
│   │       └── ReloadBtn    # Hot reload trigger
│   └── wasm/                # Game-specific WASM build
│
└── shared/                  # Shared TypeScript types
    └── src/types/           # Asset schemas, API contracts
```

### Authentication Model
- **Editor**: Cognito authentication required to write assets to S3
- **Game**: No authentication - reads assets from public CDN/S3

### Hot Reload Flow
1. Game loads Rhai scripts from storage (local dev or CDN)
2. User edits script (in-game ScriptPanel OR external file)
3. Click "Reload" → WASM fetches fresh scripts → re-executes
4. Game continues with new AI/abilities/rules - no restart needed

### Consequences
- Editor and game can be deployed independently
- Game is freely accessible (no login friction)
- Editor protected by authentication
- Shared Rust core ensures consistency
- Slightly more complex build/deploy pipeline

---

## ADR-005: Freedom Board — Hybrid HashMap + Quadtree Spatial Storage
**Date:** 2026-03-20
**Status:** Accepted

### Context
Freedom Board is an infinite sparse tile canvas (editor + runtime). Needs O(1) point access for tile placement/removal and O(log N) range queries for viewport culling. The grid is unbounded (negative and positive coordinates). Millions of tiles may exist.

### Options Considered
1. **Dense 2D array** — O(1) access but wastes memory on sparse worlds, requires fixed bounds.
2. **HashMap<TileCoord, TilePlacement>** — O(1) point access, no spatial queries, poor cache locality for neighbor lookups.
3. **Quadtree only** — Good spatial queries, O(log N) point access (slower than needed for per-frame tile placement).
4. **Hybrid: HashMap<ChunkCoord, Chunk> + QuadTreeIndex** — O(1) point access via chunk lookup + array index, O(log N) range queries via quadtree over chunk coordinates. Cache-friendly: 32x32 chunk with 8 layers (64KB) fits Apple Silicon L1 cache for neighbor lookups.

### Decision
Option 4: Hybrid HashMap + Quadtree.

- Primary storage: `HashMap<ChunkCoord, Chunk>` where Chunk is a flat `[Option<TilePlacement>; 1024]`.
- Spatial index: `QuadTreeIndex` over non-empty chunk coordinates with LOD aggregation.
- Chunk size 32x32 with MAX_LAYERS=8 per cell. Memory: 8 bytes × 8 layers × 1024 cells = 64KB per chunk. Fits Apple Silicon L1 (64-128KB), exceeds x86 L1 (32KB).
- Quadtree grows dynamically by wrapping the old root as a quadrant of a new doubled root.

### Consequences
- Point operations (place/erase) are O(1): chunk lookup + array index.
- Viewport queries are O(k + log N): quadtree prunes, then iterate chunk tiles.
- Memory proportional to occupied area only (sparse). Empty chunks are never allocated.
- LOD rendering infrastructure ready (aggregate color/density propagated through quadtree).
- Negative coordinates work correctly via Euclidean division.
- Trade-off: two data structures must stay synchronized (chunk insert/remove must update quadtree).

---

## ADR-006: Feathered Tile Edges Replace Transition Sprites
**Date:** 2026-03-21
**Status:** Accepted

### Context
The original tile rendering system used 8-directional transition sprites (atlas rows 1-8) to blend between different terrain types. This required:
- Pre-generated transition PNGs per tile type (8 extra atlas rows per tile)
- A dominance rule (higher asset_id wins) to decide which tile's transition to draw
- Transition entity spawning (up to 8 extra entities per visible tile)
- Corner-case handling for multi-type junctions and buffer zones

The system worked but was complex, brittle, and expensive in entity count.

### Options Considered
1. **Keep transition sprites** — Proven, but requires 8x atlas space, dominance logic, corner cases.
2. **Runtime shader blending** — Per-pixel blend at tile boundaries. Clean but requires WebGPU (not available while force2D) and engine modifications.
3. **Feathered tile edges** — Pre-bake an alpha gradient into the edges of each sprite at atlas conversion time. Adjacent tiles' feathered edges overlap via standard source-over compositing. No transition logic, no extra entities, no dominance rules.

### Decision
Option 3: Feathered tile edges, applied at atlas conversion time.

**Sprite geometry:** 128x128 logical tiles → 160x160 feathered sprites (16px padding per side). The original content sits at pixels [16,16] to [143,143]. The 16px padding is filled with mirrored edge pixels and alpha-faded.

**Alpha profile (asymmetric, optimized for source-over compositing):**
```
Inside band:   100% → edge_alpha   over feather_width pixels
Outside band:  edge_alpha → 0%     over feather_width pixels
```

**Parameters:**
- `feather_width = 8` (configurable 1-16)
- `edge_alpha = 0.8` (configurable 0.0-1.0)

**Why asymmetric (not 50% at edge):** Source-over compositing formula `result = a + b*(1-a)` cannot produce 100% from two sub-100% values. At edge_alpha=0.5, same-type seams composite to 75% (visible). At edge_alpha=0.8, they composite to 96% (nearly invisible). The trade-off is that the inside feather band is subtle (100%→80%), but the outside band (80%→0%) still provides visible soft transitions between different tile types.

**Rendering model:** Each tile entity is scaled by `zoom * (160/128)` so the 128px content maps to `zoom` screen pixels and the feather extends past the cell boundary. Entity position stays centered on the tile. No special compositing — standard source-over via Canvas2D `drawImage`.

### Consequences
**Eliminated:**
- Atlas rows 1-8 (transition sprites) — atlas files shrink ~89% for terrain tiles
- Transition generation in `bake-atlases.ts` and TileEditor
- Dominance rule and 8-directional transition logic in MapEditor and GameCanvas
- `transition_neighbors()` use case — never needed
- `has_transitions` flag in tile definitions
- Up to 8 extra entities per visible tile at terrain boundaries

**Added:**
- `tools/feather_atlases.py` — converts 128x128 atlases to 160x160 with feathered edges
- `SPRITE_SCALE = 160/128 = 1.25` constant in WASM renderer
- `assets_feathered.json` — asset registry pointing to feathered atlas PNGs

**Retained (unchanged):**
- Path connectivity (4-bit bitmask, 15 variations) — structural, not visual blending
- Bridge auto-placement — structural overlay, not edge blending
- Layer ordering — terrain, paths, bridges, entities
- Core entities (SparseWorld, Chunk, TilePlacement)

**Production pipeline (future):**
Tile Editor → tile PNGs → `feather_atlases` (Python locally, WASM in AWS) → feathered atlases → Map Editor / Game Renderer / Freedom Board.

**Technical debt:**
- `feather_atlases.py` is Python; production (AWS) needs a WASM equivalent
- The existing MapEditor and GameCanvas still use the old transition system; must be migrated
- Atlas rows 1-8 still exist in the current tile PNGs on disk; can be stripped once all consumers are migrated

Update: Freedom Board is the active feathered-rendering path, and MapEditor terrain no longer depends on transition skirts. Legacy transition PNGs still exist as source artifacts.

---

## ADR-007: Multi-Layer Tile Storage (8 Layers per Cell)
**Date:** 2026-03-21
**Status:** Accepted

### Context
The single-layer SparseWorld stored one `Option<TilePlacement>` per coordinate. Placing a river over grass REPLACED the grass. Multiple visual layers (ground, water, bridges, paths, objects, characters) could not coexist at the same position. This made the rendering system unable to show terrain underneath paths/rivers.

### Options Considered
1. **Multiple SparseWorlds** — One per layer. No core changes, but N quadtrees, N HashMaps, complex coordination.
2. **Layer-indexed Chunk** — Change `[Option<TP>; 1024]` to `[[Option<TP>; MAX_LAYERS]; 1024]`. Single quadtree, O(1) access by layer.
3. **SmallVec per cell** — Variable-size stack per cell. Heap fallback, poor cache locality, no fixed layer ordering.

### Decision
Option 2: Layer-indexed Chunk with `MAX_LAYERS = 8`.

**Storage layout:** `tiles[cell_index][layer]` — the `TilePlacement.layer` field (which already existed) serves as the array index.

**Memory per chunk:** 8 bytes × 8 layers × 1024 cells = 64 KB.
- Exceeds 32 KB L1 on x86
- Fits 64-128 KB L1 on Apple Silicon (primary development target)
- Fits L2 universally (256 KB+)

**Layer semantics:**

| Layer | Semantic       | Tile Types              |
|-------|---------------|-------------------------|
| 0     | Ground        | Terrain (grass, dirt)    |
| 1     | Water         | Rivers, oceans          |
| 2     | Bridge        | Auto-placed bridges     |
| 3     | Path          | Roads, land paths       |
| 4-7   | Reserved      | Objects, characters, UI  |

**API changes (breaking):**
- `Chunk::get(lx, ly)` → `Chunk::get(lx, ly, layer)`
- `Chunk::remove(lx, ly)` → `Chunk::remove(lx, ly, layer)`
- `SparseWorld::get(coord)` → `SparseWorld::get(coord, layer)`
- `SparseWorld::remove(coord)` → `SparseWorld::remove(coord, layer)`
- `SparseWorld::neighbors_4(coord)` → `SparseWorld::neighbors_4(coord, layer)`
- `erase_tile(world, coord)` → `erase_tile(world, coord, layer)`
- `connectivity_bitmask(world, coord)` → `connectivity_bitmask(world, coord, layer)`
- Added: `Chunk::get_stack(lx, ly)`, `SparseWorld::get_stack(coord)`, `is_occupied_on_layer()`

**Rendering:** Single-pass sorted by layer (back-to-front) replaces the 4-pass type-filtered approach. `check_water_underneath()` now does a direct layer lookup (layers 0-1) instead of the neighbor heuristic.

**React UI:** Layer auto-derived from tile type via `tileTypeToLayer()`. No manual layer selector needed yet.

### Consequences
- Ground is visible underneath rivers, bridges, and paths
- Tiles on different layers at the same position are independently erasable
- `tile_count` now counts total occupied layer slots across all cells
- Connectivity bitmask is layer-specific
  Current semantic rule:
  - water paths connect only to same-type water neighbors on the same layer
  - land paths connect to adjacent land-path neighbors on the same layer, regardless of exact asset type
- 64 KB chunk size may cause cache pressure on x86; monitor if cross-platform performance matters
