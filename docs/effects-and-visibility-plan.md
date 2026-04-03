# Effects and Visibility Integration Plan

## Status: Accepted (2026-04-02)

This plan describes how ZapSquad adopts the new zap-engine capabilities
(per-sprite blend modes, alpha particles, visibility mask) through
clean architecture boundaries.

---

## Engine Contract Freeze

**Assumption: zap-engine rendering and protocol capabilities are frozen for the
duration of Streams 1 and 2 Phase 1.**

The frozen baseline is zap-engine commit `3986dbe` (2026-04-02):

| Capability | Engine API | Protocol |
|---|---|---|
| Per-sprite blend modes | `SpriteComponent.blend: BlendMode` | v5, 5-float batches |
| Alpha particles (smoke/dust) | `EffectsState.spawn_alpha_particles()` | Alpha effects section in SAB |
| Additive particles (sparks/fire) | `EffectsState.spawn_particles()` | Existing effects section |
| Electric arcs (beams/lightning) | `EffectsState.add_arc()` | Existing effects section |
| Visibility mask | `VisibilityMask` + `GameConfig.visibility_cols/rows` | Visibility section in SAB |
| HDR/EDR glow | Tier-aware `GLOW_MULT` in `fs_additive` shader | Existing |
| Dynamic point lights | `LightState` with normal maps | Existing |

**Potential future engine work remains possible** for hero-quality smoke (textured
sprite-based volumetrics) and advanced fog requirements (multiple simultaneous team
masks, LOS acceleration structures, richer edge filtering). That work is explicitly
deferred and will be treated as a deliberate contract change if needed.

**Any engine upgrade during ZapSquad integration must be treated as a deliberate
contract change, not incidental background churn.** The protocol mismatch regression
of 2026-04-02 (stale WASM binary against protocol v5 TypeScript) demonstrated the
cost of uncontrolled engine changes.

---

## Architecture

```
core/
  entities/game_rules/event.rs    Semantic domain events (ShotResolved, HitOccurred,
                                  ExplosionOccurred, UnitKilled, HazardTriggered).
                                  Pure domain vocabulary. No visual language.

  entities/visibility.rs          TeamVisibility: per-team grid of CellState
                                  (Hidden | Explored | Visible).
                                  Owned by GameSession. Play-mode only.

adapters/
  effect_projection.rs            Maps GameEvent -> Vec<VisualEffect>.
                                  VisualEffect is adapter vocabulary: Beam, SparkBurst,
                                  SmokePuff, DustCloud, DeathFlash, MuzzleFlash, etc.
                                  This is the art-direction seam. Swappable per
                                  game package in the future.

  visibility_mapper.rs            Maps TeamVisibility -> Vec<u8> mask bytes.
                                  CellState::Hidden -> 0, Explored -> 128, Visible -> 255.
                                  Pure translation, no engine types.

infrastructure/wasm-canvas/
  lib.rs                          Reads VisualEffects, calls ctx.effects / ctx.scene.
                                  Reads visibility bytes, writes to ctx.visibility.
                                  Filters entity spawning based on core visibility.
                                  All engine coupling isolated here.
```

### Key Design Decisions

**Semantic events in core, not visual intents.** Core emits `ShotResolved`,
not `Beam`. Visuals iterate faster than gameplay semantics. The same domain
event may map to different visuals for different game packages. Core never
names beams, smoke, or sparks.

**Adapter owns art direction.** `effect_projection.rs` is the sole mapping
from domain events to visual vocabulary. Infrastructure performs the mechanical
translation from `VisualEffect` to engine API calls.

**Effect projection is general, not combat-specific.** Effects can originate
from rules scripts, hazards, world-gen startup flourishes, UI-triggered
actions, and future object interactions. The projection seam handles any
`GameEvent`, not just attack outcomes.

**Smoke is phased.** Phase 1 uses alpha particles (quantity, physics,
procedural geometry). Phase 2 adds sprite-based animated smoke if visual
fidelity requires it. The adapter doesn't change between phases -- only the
infrastructure translation for `SmokePuff` changes.

**Fog is play-mode only.** Authored world and live session state remain
cleanly separated per VISION.md. Visibility state is owned by `GameSession`.

**Hidden enemies are not rendered.** Infrastructure filters entity spawning
based on core visibility. No information leakage, even through debug tools.
The engine mask handles terrain/decoration dimming; entity filtering handles
actors.

---

## Stream 1: Stabilize Engine Contract + Blend Path

**Prerequisites:** None.
**Engine changes required:** None.
**Risk:** Low.

### 1A. Batch Budget (DONE - 2026-04-02)

Raised `max_layer_batches` from 64 to 256 in `GameConfig`.

Rationale:
- Freedom Board is atlas-heavy: 26+ seed atlases, plus baked character overlays.
- Batch count = visible_layers x blend_modes_used x visible_atlases.
- With 6 layers, 2 blend modes, and 30+ atlases, theoretical max exceeds 300.
- Practical max with typical viewport: 80-120.
- 256 provides robust headroom at 5KB SAB cost (256 x 5 floats x 4 bytes).
- The engine default (96) is sized for generic examples, not Freedom Board's
  product surface.

This is a ZapSquad-specific capacity decision. It scales with atlas count and
blend mode usage, not entity count.

### 1B. Document GameConfig in lib.rs

Add inline documentation explaining each capacity value, its derivation, and
the conditions under which it should be revisited.

### 1C. Validate Blend Path End-to-End

Create a minimal test: spawn one entity with `BlendMode::Additive` and verify
it renders through the full pipeline (WASM -> SAB -> renderer). This confirms
the protocol v5 blend field survives the entire data path.

Approach: add a debug key binding (or script command) that spawns a temporary
additive-blend sprite at the camera center. Visual confirmation. No core model
needed -- this is a pure infrastructure smoke test.

### 1D. Rebuild Protocol

After any `GameConfig` or engine integration change, run `make wasm-canvas`
and verify the served WASM binary matches the current engine. This is the
lesson from the 2026-04-02 protocol mismatch regression.

---

## Stream 2: Effect Pipeline

**Prerequisites:** Stream 1 complete.
**Engine changes required:** None for Phase 1. Possible for Phase 2 hero smoke.
**Risk:** Medium (requires new adapter module and event extensions).

### Phase 1: Additive Effects + Alpha Particles

#### 2A. Extend GameEvent in Core

Extend the semantic event variants in `core/entities/game_rules/event.rs`.

**Implemented (2026-04-02):**

- `AttackResolved { attacker_id, target_id, damage, hit, attacker_pos, target_pos }`
  Emitted by infrastructure after `apply_damage`. Carries world-space positions
  at attack time. Name chosen over `ShotResolved` because it covers both melee
  and ranged attacks.

**Future (not yet implemented):**

- `ExplosionOccurred { position, radius, cause }` — for area effects
- `HazardTriggered { position, hazard_type }` — for environment effects

Events must be emittable from:
- Combat use cases (attack resolution) — DONE
- Rules script commands (EmitEvent) — future
- Hazard triggers — future
- World-gen flourishes — future

#### 2B. Build effect_projection.rs in Adapters

Define `VisualEffect` enum.

**Implemented (2026-04-02):**

```
Beam { from: (f32,f32), to: (f32,f32) }
SparkBurst { position: (f32,f32), intensity: f32 }
```

**Future (not yet implemented):**

```
MuzzleFlash { at, direction }
SmokePuff { at, radius, duration }
DustCloud { at, radius }
DeathFlash { at }
```

Implement `fn project_effects(event: &GameEvent) -> Vec<VisualEffect>`.

This function is the art-direction seam. Current mappings:
- `AttackResolved { hit: true }` -> `[Beam, SparkBurst]`
- `AttackResolved { hit: false }` -> `[Beam]`

Future mappings:
- `ExplosionOccurred` -> `[SparkBurst, SmokePuff, DustCloud]`
- `UnitKilled` -> `[DeathFlash, SmokePuff]`

No engine types. No framework dependencies. Testable off-target.
7 unit tests in `adapters/src/effect_projection.rs`.

#### 2C. Build Effect Translator in Infrastructure

In `wasm-canvas/lib.rs` (or extracted module):

Maps each `VisualEffect` to zap-engine API calls:
- `Beam` -> `ctx.effects.add_arc(from, to, depth, color)`
- `SparkBurst` -> `ctx.effects.spawn_particles(center, count, speed, width, lifetime)`
- `MuzzleFlash` -> sprite with `BlendMode::Additive` on VFX layer
- `SmokePuff` -> `ctx.effects.spawn_alpha_particles(center, count, speed, width, lifetime, layer)`
- `DustCloud` -> alpha particles with short lifetime and high drag
- `DeathFlash` -> short-lived additive sprite + spark burst

#### 2D. Wire First Concrete Case

Attack resolution -> `AttackResolved` event -> `project_effects` -> engine calls.

This validates the full pipeline: core event emission, adapter projection,
infrastructure translation, engine rendering. **DONE (2026-04-02).**

#### 2E. Test Effect Projection Off-Target

`project_effects` is a pure function. Unit tests verify:
- Each domain event maps to expected visual effects
- Missing/unknown events produce empty vec (no panic)
- Effect parameters are reasonable (no NaN positions, positive durations)

### Phase 2: Hero Smoke (Deferred)

If product requires richer explosion visuals than alpha particles provide:
- Add sprite-animated smoke using normal alpha-blended sprites on a
  designated layer.
- Infrastructure translates `SmokePuff` to sprite animation instead of
  (or in addition to) alpha particles.
- Adapter code does not change.
- May require additional atlas assets (smoke sprite sheet).
- May require engine work if layering/compositing behavior is insufficient.

This phase is explicitly deferred. Alpha particles are the initial art path.

---

## Stream 3: Fog of War

**Prerequisites:** None (independent of Stream 2). Can run in parallel after
core visibility entity is defined.
**Engine changes required:** None for first implementation.
**Risk:** High (largest architectural surface, touches core + adapters +
infrastructure + product behavior).

### 3A. TeamVisibility Entity in Core

```rust
// core/entities/visibility.rs

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CellState {
    Hidden,     // Never seen. Not rendered. Black in mask.
    Explored,   // Previously seen. Dimmed in mask. Static content visible.
    Visible,    // Currently seen. Fully lit. All content visible.
}

pub struct TeamVisibility {
    cols: u32,
    rows: u32,
    grid: Vec<CellState>,
}
```

Per-team. Owned by `GameSession`. Created when play starts, destroyed when
play stops. Grid dimensions are a game-definition parameter (not hardcoded).

#### Vision update semantics:
- Radius-only first implementation. Line-of-sight deferred.
- Each character has a `vision_range: u32` (stat or template field).
- On each tick (or on movement), update visible cells within radius.
- Previously visible cells transition to `Explored` when no longer in range.
- `Hidden` cells never transition directly to `Explored` -- they must pass
  through `Visible` first.

#### Reset semantics:
- Play start: all cells `Hidden`.
- Play stop: visibility state destroyed. Board returns to full visibility
  (edit mode has no fog).

### 3B. Vision Update Use Case in Core

```rust
// core/use_cases/visibility.rs

fn update_visibility(
    team_vis: &mut TeamVisibility,
    observers: &[(TileCoord, u32)],  // (position, vision_range)
) { ... }
```

Pure function. Testable off-target. No engine types.

Marks cells within each observer's radius as `Visible`. All other previously
`Visible` cells transition to `Explored`. `Hidden` cells outside all radii
remain `Hidden`.

### 3C. Visibility Mapper in Adapters

```rust
// adapters/visibility_mapper.rs

fn map_to_mask_bytes(team_vis: &TeamVisibility) -> Vec<u8> {
    team_vis.grid.iter().map(|cell| match cell {
        CellState::Hidden   => 0,
        CellState::Explored => 128,
        CellState::Visible  => 255,
    }).collect()
}
```

Pure translation. The 128 value for `Explored` produces ~50% darkness in the
engine mask. Tunable without touching core.

### 3D. Wire into Infrastructure

1. Set `GameConfig.visibility_cols` and `visibility_rows` based on world
   bounds (or game definition parameter).
2. Each frame during play mode:
   - Collect observer positions and vision ranges from live characters.
   - Call `update_visibility()` with current team's observers.
   - Call `map_to_mask_bytes()` to produce the byte grid.
   - Write bytes into `ctx.visibility`.
3. Filter entity spawning: skip `ctx.scene.spawn()` for enemy characters
   on cells where the viewing team's visibility is `Hidden`.

### 3E. Product Decisions (Locked)

| Decision | Answer | Rationale |
|---|---|---|
| Fog scope | Play-mode only | Keeps authored/live state separated (VISION.md) |
| Explored-not-visible | Dimmed (3-state byte) | Fits engine mask naturally; provides exploration memory |
| Hidden enemies | Not rendered | No information leakage; semantically honest |
| Vision model | Radius-only (Phase 1) | LOS deferred to avoid premature complexity |
| Grid resolution | Per-tile | Matches SparseWorld granularity |

### 3F. Future Engine Work (Not Planned)

The following would require breaking the engine freeze:
- Multiple simultaneous team masks (spectator view showing all teams)
- GPU-accelerated LOS computation
- Separate explored/current GPU channels for richer rendering
- Edge smoothing beyond the engine's built-in interpolation modes

These are deferred. The first implementation covers single-team fog with
radius-based vision, which is sufficient for the initial playable product.

---

## Execution Order

```
Stream 1 (immediate, no design risk)
  1A. Batch budget -> 256                               DONE
  1B. Document GameConfig capacities
  1C. Validate blend path end-to-end
  1D. Rebuild WASM after changes                        DONE

Stream 2 Phase 1 (after Stream 1, medium risk)
  2A. Extend GameEvent with AttackResolved                  DONE
  2B. Build effect_projection.rs (7 tests)                  DONE
  2C. Build effect translator in infrastructure             DONE
  2D. Wire attack -> AttackResolved -> Beam + SparkBurst    DONE
  2E. Test effect projection off-target (7 tests)           DONE

Stream 3 (parallel with Stream 2 after 3A)
  3A. TeamVisibility entity in core
  3B. Vision update use case
  3C. Visibility mapper in adapters
  3D. Wire into infrastructure
  3E. Product tuning (dimming values, vision ranges)

Stream 2 Phase 2 (deferred, may require engine work)
  Hero smoke if alpha particles are visually insufficient
```

Stream 1 is prerequisite for Stream 2.
Stream 3 is independent after 3A.
Stream 2 Phase 2 is deferred indefinitely.

---

## Technical Debt Created by This Plan

- **Alpha smoke is not hero-quality.** Procedural alpha geometry is functional
  but may look cheap for large explosions. Tracked as Phase 2 option.
- **Vision is radius-only.** No line-of-sight occlusion. Walls and obstacles
  do not block vision in Phase 1.
- **Single-team fog.** Only the active team's visibility is rendered. Spectator
  mode showing multiple teams requires engine work.
- **Batch budget is static.** 256 is generous but not computed from the actual
  manifest. If atlas count exceeds ~40 with heavy additive usage, revisit.
- **Effect projection is not script-controllable.** The adapter mapping is
  compiled Rust, not Rhai. Script authors cannot customize visual effects
  in Phase 1. This is intentional -- art direction should be stable before
  exposing it to scripting.
- **engine.worker.ts accumulates game-specific polling hooks.** The worker
  now has 6 named Freedom Board exports: `take_world_export`,
  `take_selected_character_info`, `take_game_hud_state`, `take_start_errors`,
  `take_compile_results`, plus session control functions. This should
  eventually be generalized into a "custom JSON drains" mechanism where
  WASM registers named channels and the worker polls a single
  `take_pending_messages()` export. Not urgent — the current hooks are
  stable and low-maintenance — but the pattern doesn't scale to 20+ hooks.
- **Arc lifecycle is managed by frame countdown, not engine-native lifetime.**
  The engine's `add_arc()` pushes arcs permanently. ZapSquad manages expiry
  via `effects_clear_countdown` / `BEAM_LIFETIME_FRAMES` (18 frames = 300ms).
  When the countdown expires, `ctx.effects.clear()` sweeps all effects.
  This means overlapping rapid-fire attacks reset the countdown, extending
  visibility of earlier arcs. If the engine later adds per-arc lifetime,
  this workaround should be removed.
- **`clear()` is coarse.** It removes arcs AND particles. The countdown is
  set to match spark particle lifetime (0.3s) so particles are naturally
  dead by cleanup time. If future effects need longer particle lifetimes,
  this coupling breaks — would need selective arc clearing in the engine.
