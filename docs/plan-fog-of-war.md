# Fog of War — Implementation Plan

## Status: Layers 1-3 Complete, Layer 4 Partial (2026-04-03)

This document describes the fog of war system in ZapSquad: what was built,
the architectural pivot from dense mask to sparse chunks, what works, and
what remains.

---

## Architecture

```
core/entities/game_rules/visibility.rs
    CellState: Hidden | Explored | Visible
    TeamVisibility: sparse HashMap<ChunkCoord, VisibilityChunk>
    Aligned to SparseWorld's 32x32 chunk model.
    Untracked chunks are implicitly Hidden.
    No bounded rectangle. No coordinate compression.

core/use_cases/visibility.rs
    Observer { tile_x, tile_y, range }
    update_visibility(vis, observers)
    Sparse-aware: demotes only previously_visible set,
    reveals only cells within observer radii.

adapters/visibility_mapper.rs
    cell_to_byte(CellState) -> u8
    fog_alpha(CellState) -> f32
    Utility functions for rendering. No chunk projection DTOs yet.

infrastructure/wasm-canvas/lib.rs
    team_visibility: Option<HashMap<TeamId, TeamVisibility>>
    viewing_team: Option<TeamId>
    Lifecycle: created on session start, destroyed on stop.
    Per-tick: collect observers -> update_visibility per team.
    Gating: is_actor_visible_to_viewer() gates rendering,
            selection, targeting, click lookup, and effects.
    Visual: draw_fog_overlay() renders vector rectangles (interim).
```

---

## What Was Built

### Layer 1: Core Domain Model

**Entity: `TeamVisibility`** (visibility.rs)

Sparse per-team visibility grid using `HashMap<ChunkCoord, VisibilityChunk>`.
Each chunk stores CHUNK_SIZE x CHUNK_SIZE (32x32 = 1024) CellState values.
Only chunks with non-Hidden cells are tracked. This matches the SparseWorld
storage model and supports infinite canvas without bounded-grid assumptions.

Public API:
- `new(team_id)` — empty visibility, all implicit Hidden
- `get_world(tile_x, tile_y)` — returns CellState (Hidden for untracked)
- `set_world(tile_x, tile_y, state)` — creates chunk on demand
- `is_visible(tile_x, tile_y)` / `is_explored(tile_x, tile_y)`
- `clear()` — drops all chunks
- `chunks()` — iterate tracked chunks
- `previously_visible()` / `set_previously_visible()` — for efficient demotion
- `prune_empty_chunks()` — optional memory cleanup

9 entity tests.

**Use Case: `update_visibility`** (use_cases/visibility.rs)

Sparse-aware two-phase algorithm:
1. Demote previously-visible cells to Explored (using tracked set, not full scan)
2. For each observer, promote cells within Euclidean radius to Visible

Properties:
- Only touches cells that change state
- Cross-chunk-boundary aware
- No line-of-sight occlusion (radius-only, Phase 1)
- Stores new Visible set for next frame's demotion pass

11 use case tests.

### Layer 2: Adapter Translation

**`visibility_mapper.rs`**

Utility functions:
- `cell_to_byte(CellState) -> u8` — Hidden=0, Explored=128, Visible=255
- `fog_alpha(CellState) -> f32` — Hidden=1.0, Explored=0.5, Visible=0.0
- `EXPLORED_BRIGHTNESS: u8 = 128` — tunable dimming constant

The dense `map_to_mask_bytes()` function was removed when fog storage
pivoted from bounded rectangle to sparse chunks. Chunk-level fog
projection DTOs have not yet been implemented — they will be needed
when fog tile sprites replace vector rectangles.

2 adapter tests.

### Layer 3: Infrastructure Application

**Lifecycle:**
- `start_game_session()`: creates one `TeamVisibility::new(team_id)` per team.
  Sets `viewing_team` to first human-controlled team.
- `stop_game_session()`: sets `team_visibility = None`, `viewing_team = None`.

**Per-tick update (when not paused):**
- `update_fog_of_war()` collects observers from live characters.
  Vision range from character stat `vision_range`, fallback to
  `DEFAULT_VISION_RANGE = 5` tiles. Calls `update_visibility` per team.

**Entity gating — `is_actor_visible_to_viewer(actor_id)`:**
- Returns true if: no session, no fog, own team, or tile is Visible.
- Returns false if: enemy on Hidden or Explored tile.
- Consumed by:
  - `find_character_at()` — hidden enemies excluded from click lookup
  - `rebuild_character_entities()` — hidden enemies not spawned as entities
  - `SELECT_CHARACTER` handler — uses `find_character_at`, so hidden enemies
    cannot be selected
  - `MOVE_CHARACTER` attack branch — uses `find_character_at`, so hidden
    enemies cannot be targeted

**Effect gating — `is_world_pos_visible(wx, wy)`:**
- `translate_visual_effect()` checks visibility before spawning engine effects.
- Beam: suppressed if BOTH endpoints are hidden. If either endpoint is
  visible (e.g., player's attacker fires at a fogged target), the beam
  renders — the player sees the shot leave.
- SparkBurst: suppressed if position is hidden.

**Visual fog overlay (interim):**
- `draw_fog_overlay()` draws vector rectangles over Hidden (alpha 0.92)
  and Explored (alpha 0.45) cells in the viewport.
- Uses `ctx.vectors.fill_rect()` with `VectorColor::new(0, 0, 0, alpha)`.
- Runs each frame during play, after debug overlays, before character vectors.
- This is temporary — see "What Remains" below.

**Engine mask: NOT USED.**
- `GameConfig.visibility_cols/rows` are 0. No `ctx.visibility` writes.
- The dense engine mask was abandoned because it assumes a bounded world,
  which is structurally wrong for the infinite-canvas product.

**Render layer reservation:**
- `storage_to_render_layer` maps storage layers 3-4 to Foreground (world
  substrate). VFX(4) is reserved for future fog sprite entities.
- Characters render at UI(5), above fog layer.
- Combat effects use the engine effects pipeline, not tile layers.

11 infrastructure fog tests.

---

## Abandoned Approach: Dense Engine Mask

The first fog implementation used a bounded dense `Vec<CellState>` with
fixed `cols/rows/origin`, uploaded to the engine's `VisibilityMask` via
`ctx.visibility` each frame.

Problems:
- Hardcoded 64x64 window permanently hid anything outside it
- Growth to world-bounds-derived rectangle added coordinate compression
- Engine mask lifecycle edge cases (stale mask after stop)
- Fundamentally wrong for an infinite sparse canvas product

The dense approach was replaced with sparse chunked storage. The engine
mask is no longer used. The `map_to_mask_bytes` adapter function was
removed.

---

## Product Decisions (Locked)

| Decision | Answer | Rationale |
|---|---|---|
| Fog scope | Play-mode only | Keeps authored/live state separated per VISION.md |
| Cell states | Hidden / Explored / Visible | Three-state model with exploration memory |
| Hidden enemies | Not rendered, not interactable | No information leakage; gated before spawn |
| Hidden effects | Suppressed (beams if both ends hidden, sparks if position hidden) | Prevents effects punching through fog |
| Vision model | Radius-only (Phase 1) | LOS deferred to avoid premature complexity |
| Storage model | Sparse chunked (HashMap by ChunkCoord) | Matches SparseWorld; no bounded rectangle |
| Viewing team | First human-controlled team | Single-team fog for now |

---

## What Remains

### 1. Fog Tile Sprites (Replaces Vector Rectangles)

The current vector-rectangle fog is functional but visually crude:
- Hard tile-sized boundaries, no edge transitions
- Vectors render after ALL sprites in the engine pipeline, meaning
  additive effects could theoretically punch through (mitigated by
  effect gating, but not perfectly sealed by rendering order)
- Does not match the board's visual language

The correct product implementation:
- Fog tile sprites baked into an atlas with feathered edge transitions
  (same technique as terrain tile feathering)
- Hidden/Explored/Visible boundaries get autotiled transition variants
  (similar to path connectivity bitmask → sprite variant selection)
- Fog entities spawned on RenderLayer::VFX(4), which renders between
  world substrate (Foreground/3) and characters (UI/5)
- Only dirty chunks need regeneration — not a full viewport scan per frame

Work required:
- Fog sprite atlas art (solid dark tiles with alpha + feathered edges)
- Adapter: chunk-level fog projection DTOs with edge variant metadata
- Infrastructure: fog entity spawning/despawning per chunk
- Autotiling rules for fog boundaries (connectivity bitmask)
- Baking pipeline integration (optional — may be runtime-computed)

### 2. Per-Character Vision Range

The runtime already reads `vision_range` from the character's stat map
and only falls back to `DEFAULT_VISION_RANGE = 5` when the stat is
absent. No core or infrastructure code changes are needed.

What remains is asset/schema/editor work:
- Character templates need `vision_range` in their `base_stats` maps
- The game definition editor should expose vision range as a stat field
- Possibly per-weapon or per-equipment vision modifiers (product tuning)

### 3. AI Vision Gating

Currently AI scripts have omniscient vision — `find_nearest` returns
all characters regardless of team visibility. This is common for RTS
games (AI doesn't cheat visually but knows positions) but could be
gated for fairness:
- `find_nearest` in `CharacterAiContext` could filter by team visibility
- Decision: intentional AI omniscience or fog-aware AI

### 4. Product Tuning

- Explored dimming value (currently 0.45 alpha, `EXPLORED_BRIGHTNESS = 128`)
- Hidden darkness (currently 0.92 alpha)
- Vision range per unit type / weapon / equipment
- Edge rendering quality (feathering radius, transition smoothness)
- Whether explored cells show enemy buildings/objects or just terrain

### 5. Future Engine Work (Not Planned)

These would require breaking the engine freeze:
- Multiple simultaneous team masks (spectator mode)
- GPU-accelerated LOS computation
- Separate explored/current GPU rendering channels
- Per-layer vector drawing (would eliminate the vector-fog ordering issue)

---

## Test Coverage

### Core (20 tests)

Entity tests (visibility.rs):
- `new_visibility_is_all_hidden`
- `set_and_get_world`
- `negative_coordinates`
- `setting_hidden_does_not_create_chunk`
- `clear_drops_all_chunks`
- `is_visible_and_is_explored`
- `cross_chunk_boundary`
- `prune_empty_chunks`
- `chunks_iterator`

Use case tests (use_cases/visibility.rs):
- `single_observer_reveals_circle`
- `visible_demotes_to_explored_when_observer_moves`
- `hidden_never_becomes_explored_directly`
- `no_observers_demotes_all_visible`
- `multiple_observers_union`
- `overlapping_observers`
- `negative_coordinates`
- `zero_range_observer_reveals_only_own_cell`
- `sparse_storage_only_creates_needed_chunks`
- `cross_chunk_boundary_observation`
- `demotion_is_efficient`

### Adapter (2 tests)

- `cell_to_byte_mapping`
- `fog_alpha_values`

### Infrastructure (11 tests)

- `fog_hides_distant_enemy_from_viewer`
- `fog_shows_own_team_always`
- `fog_shows_enemy_within_vision_range`
- `fog_blocks_selection_of_hidden_enemy`
- `fog_blocks_attack_on_hidden_enemy`
- `fog_grids_created_on_session_start`
- `fog_grids_destroyed_on_session_stop`
- `fog_state_cleared_on_stop`
- `fog_suppresses_effects_at_hidden_positions`
- `fog_allows_effects_at_visible_positions`
- `no_fog_in_edit_mode`

---

## Technical Debt

- **Vector fog is temporary.** Functional but visually crude. Rendering
  order is imperfect for additive effects (mitigated by effect gating).
  Will be replaced by fog tile sprites with feathered edges.
- **Vision range is a constant (5 tiles).** Should be per-character stat.
- **AI scripts have omniscient vision.** `find_nearest` is not fog-gated.
  Intentional for now, may change later.
- **`fog_alpha()` in adapter is unused.** Will be consumed by fog sprite
  rendering when implemented.
- **No chunk-level fog projection DTOs.** Adapter currently has per-cell
  utilities only. Chunk projection needed for fog sprite spawning.
- **Explored dimming values are hardcoded.** Should be tunable per game
  definition or product configuration.
