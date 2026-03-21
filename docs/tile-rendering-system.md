# Tile Rendering System — Algorithms & Porting Reference

This document describes the **algorithms** that produce the final rendered tile canvas. It covers the feathered edge system, path connectivity, bridge auto-placement, and the render pass pipeline.

For data formats and schemas, see `data_formats.md`, `FORMAT_SPECIFICATIONS.md`, and `asset_schema.md`. For freedom-board architecture and entities, see `freedom-board.md`. For the decision rationale, see `architecture_decisions.md` ADR-006.

---

## 1. Render Pass Order

The renderer produces the final image in five ordered passes. Each pass draws to a specific `RenderLayer`. Later passes draw on top of earlier ones.

All tiles are rendered as feathered sprites (160x160 with alpha-faded edges). Standard source-over compositing handles inter-tile blending automatically — no transition logic or extra entities required.

```
Pass 1: TERRAIN (layer 0 — Background)
  For each visible tile where tileType == "TILE":
    Draw the feathered base sprite at the tile's position.
    Adjacent same-type tiles: feathered edges overlap, compositing to ~96% opacity.
    Adjacent different-type tiles: both fade toward background, creating soft separation.

Pass 2: WATER PATHS (layer 2 — Objects)
  For each visible tile where tileType == "PATH" AND terrainType == "WATER":
    Compute connectivity bitmask against same-asset_id neighbors.
    Draw the connectivity-selected feathered sprite at the tile's position.

Pass 3: BRIDGES (layer 3 — Foreground)
  For each visible tile where tileType == "PATH" AND terrainType == "LAND":
    Check the tile underneath (layer 0 at same position).
    If underneath is WATER terrain OR a WATER path:
      Look up this path's bridgeAssetId.
      Draw bridge sprite with SAME connectivity bitmask as the path.

Pass 4: GROUND PATHS (layer 4 — VFX)
  For each visible tile where tileType == "PATH" AND terrainType == "LAND":
    Compute connectivity bitmask against same-asset_id neighbors.
    Draw the connectivity-selected feathered sprite at the tile's position.

Pass 5: ENTITIES (layer 5 — UI)
  Characters, objects, selection indicators.
  (Not covered here — handled by entity system.)
```

### Why This Order Matters

- Terrain is the base. Feathered edges handle all inter-terrain blending.
- Water paths (rivers) go on top of terrain.
- Bridges go above water but below the ground path that crosses them.
- Ground paths (roads) are the topmost tile layer.

---

## 2. Terrain Tile Rendering

### Variation Selection (Seeded Pseudo-Random)

Each tile placement carries a `seed` (the `t` field from level JSON, or a random value assigned at placement time in the editor).

```
function variationFromSeed(seed: u32, variations: u32) -> u32:
    x = sin(seed * 9999.0) * 10000.0
    rand = x - floor(x)              // fractional part, range [0, 1)
    return floor(rand * variations)
```

This is deterministic: same seed always produces same variation. The sin-based hash distributes values pseudo-uniformly across variation indices.

### Sprite Resolution

```
sprite_name = "{tile_id}_{variation}"
```

Example: tile "iarba" with seed=55, variations=3 -> variation=1 -> sprite "iarba_1"

---

## 3. Feathered Tile Edge System (Replaces Transition Sprites)

Terrain blending is handled entirely by alpha-feathered tile edges. No transition sprites, no dominance rules, no directional overlays.

### Core Concept

Every tile sprite is expanded from 128x128 to 160x160 at atlas conversion time. The 16px padding on each side is filled with mirrored edge pixels and alpha-faded. When rendered, each tile extends past its cell boundary, and adjacent tiles' feathered regions overlap. Standard source-over compositing produces the visual blend.

### Sprite Geometry

```
160x160 feathered sprite:
  [0,0] to [15,15]     — padding (mirrored + faded)
  [16,16] to [143,143] — original 128x128 content
  [144,144] to [159,159] — padding (mirrored + faded)
```

The padding pixels are mirrored from the content edge:
- Padding pixel at x=15 copies content pixel at x=16
- Padding pixel at x=14 copies content pixel at x=17
- General: padding pixel at x (x < 16) copies content pixel at (31 - x)

Mirroring (rather than sampling from neighbors) ensures the feather works for all tile types including paths, where the adjacent tile's content would be wrong to extend.

### Alpha Profile (Asymmetric)

The alpha profile is designed for source-over compositing. It uses `edge_alpha` (default 0.8) at the content boundary, NOT 50%:

```
signed_d = distance from content boundary (positive = inside, negative = outside)

if signed_d >= feather:     alpha = 1.0
if 0 <= signed_d < feather: alpha = edge_alpha + (1 - edge_alpha) * (signed_d / feather)
if -feather < signed_d < 0: alpha = edge_alpha * (1 + signed_d / feather)
if signed_d <= -feather:    alpha = 0.0
```

With `feather=8, edge_alpha=0.8`:

| Position | Signed distance | Alpha |
|----------|----------------|-------|
| 8px inside content | +8 | 100% |
| 4px inside content | +4 | 90% |
| At content edge | 0 | 80% |
| 4px outside (padding) | -4 | 40% |
| 8px outside (padding) | -8 | 0% |

### Why Asymmetric (Not 50% at Edge)

Source-over compositing: `result = a + b * (1 - a)`. For two overlapping pixels at the same alpha `a`:

```
result = 2a - a^2
```

| edge_alpha | Composited | Background leak | Visual |
|-----------|-----------|----------------|--------|
| 0.50 | 75% | 25% | Clearly visible seam |
| 0.66 | 88% | 12% | Noticeable |
| 0.80 | 96% | 4% | Nearly invisible |
| 0.90 | 99% | 1% | Invisible |

At edge_alpha=0.8, same-type tile seams composite to 96% opacity — practically invisible against any background. The inside feather (100%→80%) is subtle, while the outside feather (80%→0%) provides visible soft edges between different tile types.

### Rendering Scale

Entities are scaled by `SPRITE_SCALE = 160/128 = 1.25`:

```
entity_scale = zoom * SPRITE_SCALE
```

This causes the 128px content to map to exactly `zoom` screen pixels, while the 16px feather extends past the cell boundary. Entity position stays centered on the tile (sprite center = content center at pixel 80,80).

### Conversion Tool

```bash
source .venv/bin/activate
python tools/feather_atlases.py input_dir/ output_dir/ --feather 8 --edge-alpha 0.8
```

Parameters:
- `--feather`: Width of feather band in pixels, 1-16 (default 8)
- `--edge-alpha`: Alpha at content boundary, 0.0-1.0 (default 0.8)

### What This Eliminates

- Atlas rows 1-8 (8 directional transition sprite rows per tile type)
- Dominance rule (higher asset_id projects transitions onto neighbors)
- `transition_neighbors()` use case
- `has_transitions` flag in tile definitions
- Up to 8 extra entities per visible tile at terrain boundaries
- All transition rendering logic in MapEditor, GameCanvas, and freedom-board

---

## 4. Path Connectivity Algorithm

Path tiles (roads, rivers) auto-connect to adjacent paths of the **same asset_id**.

### Bitmask Computation

```
function connectivityBitmask(world, coord, asset_id) -> u4:
    bits = 0
    if world.get(coord + N)?.asset_id == asset_id: bits |= 8   // N = bit 3
    if world.get(coord + S)?.asset_id == asset_id: bits |= 4   // S = bit 2
    if world.get(coord + W)?.asset_id == asset_id: bits |= 2   // W = bit 1
    if world.get(coord + E)?.asset_id == asset_id: bits |= 1   // E = bit 0
    return bits
```

### Variation Index from Bitmask

```
variation = (bits == 0) ? 0 : (bits - 1)
```

This maps the 16 possible bitmask values (0-15) to 15 sprite columns (0-14):
- bits=0 (isolated): variation=0
- bits=1 (E only): variation=0
- bits=2 (W only): variation=1
- bits=3 (W+E): variation=2
- ...
- bits=15 (all four): variation=14

### Sprite Resolution for Paths

```
sprite_name = "{path_tile_id}_{variation}"
```

Row 0 of the path atlas contains the 15 connectivity variants.

### Reactivity

When a path tile is placed or removed, **all 4 cardinal neighbors must recompute their connectivity**. The existing MapEditor handles this by re-scanning neighbors on every tile mutation. The freedom-board WASM must do the same: after placing/erasing a path, dirty the 4 cardinal neighbors for re-rendering.

---

## 5. Bridge Auto-Placement Algorithm

Bridges appear automatically when a ground path crosses water.

### Detection

```
function needsBridge(world, coord, path_placement, tile_registry) -> bool:
    // Only LAND paths can have bridges
    path_def = tile_registry[path_placement.asset_id]
    if path_def.tileType != "PATH": return false
    if path_def.terrainType != "LAND": return false
    if path_def.bridgeAssetId is None: return false

    // Check what's underneath at this position
    // "Underneath" = the base terrain tile at layer 0
    base_tile = world.get_base_terrain(coord)  // whatever is at layer 0
    if base_tile is None: return false

    base_def = tile_registry[base_tile.asset_id]

    // Bridge needed if base is water terrain OR a water path
    return base_def.terrainType == "WATER"
```

### Bridge Connectivity

The bridge's connectivity bitmask **matches the path above it exactly**. This ensures the bridge shape follows the road shape:

```
function renderBridge(world, coord, path_placement, path_def):
    bridge_asset_id = resolve_asset_id(path_def.bridgeAssetId)
    path_connectivity = connectivityBitmask(world, coord, path_placement.asset_id)
    bridge_variation = (path_connectivity == 0) ? 0 : (path_connectivity - 1)
    sprite_name = "{bridge_asset_id}_{bridge_variation}"

    draw(sprite_name, at: coord, layer: Foreground)
```

### Multi-Path Bridge Isolation

Different path types crossing the same water cell do NOT share a bridge. Each path type renders its own bridge independently. The path's `bridgeAssetId` determines which bridge graphic is used.

---

## 6. Atlas Layout Reference

### Current Layout (Legacy — 9 rows, includes transition rows)

All existing atlases on disk still have 9 rows. The feathered atlas conversion preserves this structure (all rows are feathered). Once all consumers are migrated to feathered edges, rows 1-8 can be stripped.

```
row 0:  Base variations (TILE) or connectivity variants (PATH/BRIDGE)
rows 1-8: Transition sprites (LEGACY — no longer used by feathered rendering)
```

### Target Layout (Post-Migration — 1 row)

After stripping transition rows:

**Terrain tiles (tileType = "TILE"):**
```
          col 0       col 1       col 2    ... col (variations-1)
row 0:  [ base_v0 ] [ base_v1 ] [ base_v2 ] ...

Total sprites = variations (1-8)
```

**Path/Bridge tiles (tileType = "PATH" or "BRIDGE"):**
```
          col 0       col 1     ... col 14
row 0:  [ conn_0  ] [ conn_1 ] ... [ conn_14 ]

Total sprites = 15
```

### Sprite Dimensions

| Stage | Sprite size | Atlas example (iarba, 3 variations) |
|-------|------------|-------------------------------------|
| Source (Tile Editor output) | 128x128 | 384x128 (1 row) or 384x1152 (9 rows) |
| Feathered (renderer input) | 160x160 | 480x160 (1 row) or 480x1440 (9 rows) |

### Sprite Index Formula

```
sprite_index = col    (when only row 0 exists)
sprite_name = "{tile_id}_{sprite_index}"
```

---

## 7. Tile Registry Extended Format

The freedom-board WASM needs more metadata than the current `TileAssetInfo { name, variations }`. To implement path connectivity and bridge auto-placement, the registry must include:

```rust
struct TileAssetInfo {
    name: String,
    variations: u8,
    tile_type: TileType,       // TILE, PATH, BRIDGE
    terrain_type: TerrainType, // LAND, WATER
    bridge_asset_id: Option<String>,  // For LAND PATH: which bridge to use
}
```

Note: `has_transitions` is no longer needed — feathered edges replace transition sprites.

React already has this data from `manifest.json`. The `reload_game_manifest` JSON payload must be extended to include these fields.

---

## 8. Porting Strategy: Where Logic Lives

### Clean Architecture Placement

| Logic | Location | Rationale |
|-------|----------|-----------|
| Connectivity bitmask | `core/use_cases` | Pure computation on SparseWorld, no framework deps |
| Bridge-needed detection | `core/use_cases` | Domain rule about terrain interaction |
| Variation-from-seed | `core/use_cases` | Pure deterministic hash |
| Sprite name resolution | `infrastructure/wasm-canvas` | Depends on engine's sprite API (volatile detail) |
| Entity spawning per pass | `infrastructure/wasm-canvas` | Engine-specific, volatile |
| Render layer assignment | `infrastructure/wasm-canvas` | Maps to engine's RenderLayer enum |
| Feathered atlas conversion | `tools/` (Python) or WASM component (production) | Asset pipeline, not runtime |

The **decision logic** (what to draw) belongs in core. The **drawing commands** (how to draw) belong in infrastructure. The **feathering** is an asset pipeline step that runs before any renderer sees the data.

### Core Functions Needed

```
// Already exists:
connectivity_bitmask(world, coord) -> u8

// New:
needs_bridge(world, coord, tile_registry) -> Option<BridgeInfo>
    // Returns: bridge asset_id, connectivity matching the path above

variation_from_seed(seed: u32, variations: u32) -> u32
    // Already implemented in WASM, should move to core
```

### WASM Layer Responsibilities

```
rebuild_visible_entities():
    visible = query_viewport(world, min, max)

    // Pass 1: Base terrain (feathered sprites handle blending automatically)
    for tile in visible where tile_type == TILE:
        spawn feathered base sprite at tile position
        scale = zoom * SPRITE_SCALE, layer = Background

    // Pass 2: Water paths
    for tile in visible where tile_type == PATH and terrain == WATER:
        compute connectivity, spawn feathered sprite, layer = Objects

    // Pass 3: Bridges
    for tile in visible where tile_type == PATH and terrain == LAND:
        if needs_bridge: spawn bridge sprite, layer = Foreground

    // Pass 4: Ground paths
    for tile in visible where tile_type == PATH and terrain == LAND:
        compute connectivity, spawn feathered sprite, layer = VFX
```

---

## 9. Known Edge Cases

1. **Chunk-boundary transitions**: A tile at chunk edge (e.g., tile 31,0) has a neighbor in a different chunk (32,0). The SparseWorld's `get()` handles cross-chunk lookups transparently, so the transition algorithm works without special casing.

2. **Transition with empty neighbor**: No transition is drawn toward empty cells. The dominance check (`neighbor.asset_id > my_asset_id`) requires a neighbor to exist.

3. **Path placed on non-water terrain**: No bridge generated. The path renders normally on its assigned layer.

4. **Multiple terrain types meeting**: A cell with 3+ different neighboring terrain types gets multiple transition overlays. Each dominant neighbor contributes its transition independently.

5. **Path connectivity across tile types**: A "drum_gri" road does NOT connect to a "river" water path. Connectivity is strictly same-asset_id.

6. **Bridge with no bridgeAssetId**: If a LAND path has no `bridgeAssetId` defined, no bridge renders even over water. The path just floats.

---

## 10. Performance Considerations

- **Feathered edges have zero runtime cost**: Alpha is pre-baked into atlas textures at conversion time. Standard source-over compositing (Canvas2D default) handles blending. No per-tile neighbor checks for transitions.

- **Entity count: 1 per visible tile** (for terrain). No transition entities. A 100x100 viewport = 10K entities maximum. Compare to the old system: up to 90K entities (1 base + 8 transitions each).

- **Path connectivity is O(4) per path tile**: 4 cardinal neighbor lookups. SparseWorld.get() is O(1). Negligible.

- **Bridge detection adds one lookup per path tile**: Check base terrain at same position. Negligible.

- **Sprite overdraw from feathered overlap**: Each tile renders at 160x160 instead of 128x128 (1.56x pixel area). Adjacent tiles overlap by 32 sprite pixels per edge. This increases fill rate but eliminates the 8 extra entity draws per tile that transitions required. Net positive.

---

## 11. Maturity: PROTOTYPE

### What's Implemented
- Feathered tile edges: `tools/feather_atlases.py` converts 128x128 atlases to 160x160
- Freedom-board renders feathered tiles via `SPRITE_SCALE = 1.25`
- Visually validated: same-type seams at 96% opacity (edge_alpha=0.8), inter-type soft edges visible

### What's NOT Yet Implemented
- Path connectivity in freedom-board WASM (connectivity_bitmask exists in core, not wired)
- Bridge auto-placement in freedom-board WASM
- Extended tile registry (tile_type, terrain_type, bridge_asset_id)
- Migration of MapEditor and GameCanvas to feathered tiles
- Stripping of transition rows 1-8 from source atlases
- WASM-based feathering for production (currently Python only)
- Integration with TileEditor save pipeline

### Source Reference

Path connectivity and bridge algorithms are proven in the TypeScript implementations:
- `ui/web/src/editors/MapEditor/index.tsx` — `renderTiles()` (lines ~600-850)
- `ui/web/src/components/GameCanvas.tsx` — render pipeline (lines ~200-500)

---

## 12. Asset Pipeline (Current and Target)

### Current Pipeline

```
Tile Editor → tile PNGs (128x128) → bake-atlases.ts → 9-row atlases (128x128 sprites)
  → convert-manifest.js → assets.json → renderers
```

### Target Pipeline

```
Tile Editor → tile PNGs (128x128, row 0 only)
  → feather_atlases (Python/WASM) → 1-row atlases (160x160 sprites)
  → convert-manifest.js (updated) → assets.json → renderers
```

### Intermediate State (Now)

```
Tile Editor → tile PNGs (128x128, 9 rows) → feather_atlases.py → 9-row atlases (160x160)
  → assets_feathered.json → freedom-board only

Original assets.json → MapEditor, GameCanvas (unchanged, still using transitions)
```

---

## Related Documents

- `docs/data_formats.md` — JSON schemas for tile definitions, manifests, levels
- `docs/FORMAT_SPECIFICATIONS.md` — Atlas structure, sprite index math, seeded variation
- `docs/asset_schema.md` — Full tile/character/object schema, path connectivity table
- `docs/freedom-board.md` — Architecture, entities, WASM integration, build commands
- `docs/architecture_decisions.md` — ADR-006: Feathered Tile Edges Replace Transition Sprites
