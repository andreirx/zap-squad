# Plan: Sandbox-First Product Model

## Objective

Transform the Freedom Board runtime from a modal play-session architecture into a
sandbox-first product where:

- The default state is a playground (draw, place, move, experiment)
- AI scripts preview in sandbox without requiring formal game activation
- A rules package is what turns the sandbox into an enforced game (`GAME ON`)
- World gen is a sandbox authoring tool, not a play-start action
- GAME OFF edits are durable; GAME ON world changes are ephemeral

This is the architectural direction described in VISION.md §5a, §5b, §5c.

---

## What Was Implemented (2026-03-28 – 2026-03-30)

### Scripting Migration (Steps 3a–3e)

All three scripting scopes are now live on the new scoped architecture:

| Engine | Scope | Entry Point | Status |
|--------|-------|-------------|--------|
| `AiScriptEngine` | character_ai | `fn update(ctx)` | Live — legacy-compatible API |
| `RulesScriptEngine` | rules | `fn on_event(ctx)` | Live |
| `WorldGenScriptEngine` | world_gen | `fn generate(ctx)` | Live |

Key implementation details:
- **Legacy ScriptEngine retired** from Freedom Board. Retained only for old standalone WASM crate.
- **AI scripts** use `CharacterAiContext` with `GameView`. Computed relations (`"enemy"`, `"ally"`) resolved from `self_team` vs `target.team_id`. Legacy function names preserved (`move_to`, `attack`, `find_nearest`, `self_pos`, `dist`, etc.).
- **Pre-flight script validation** gates play start: checks rules script, world_gen script, team controller scripts, and per-character AI scripts. Missing scripts abort with `start_failed` event and full snapshot restore.
- **World gen** runs during `start_game_session()` after validation. Places tiles (name→id resolution), spawns template-matched characters with full equipment/HP, defines zones on `GameSession`. Runtime errors abort startup with snapshot rollback. xorshift32 RNG reset to seed 42 before each run.
- **Board actor migration** into `GameSession` at play start. Template-matched when possible (inherits stats, equipment, tags). Renderer HP reconciled onto instance.
- **Damage sync** from renderer actor back to `CharacterInstance.stats["hp"]`. `UnitDamaged` event with attacker attribution on every hit. `UnitKilled` with `killer_id` on lethal damage.
- **Tag propagation** from `CharacterTemplate.tags` into `GameView.CharacterView.tags` via `build_game_view()`.
- **PrePlaySnapshot** includes full `SparseWorld` clone. Stop and failure paths restore tiles + characters.

### Rules Package Domain Model

New file: `core/src/entities/game_rules/package.rs`

| Type | Purpose |
|------|---------|
| `RulesPackage` | Activation contract wrapping `GameDefinition` + prerequisites + verifier binding |
| `Prerequisite` | Declarative UI-facing requirement (7 variants) |
| `CheckContext` | Carries world snapshot + participating teams for prerequisite evaluation |
| `WorldSnapshot` | Read-only boundary DTO: characters, objects, zones, tiles |
| `SnapshotObject` | Object entity with typed `PropertyValue` properties |
| `SnapshotTile` | Individual tile placement for spatial queries |
| `VerificationResult` | Structured pass/fail from verification phase |
| `VerificationFailure` | Individual failure with severity + message |
| `PrerequisiteCheckResult` | Per-prerequisite result with `verifier_only` flag |
| `PropertyValue` | `Bool | Int | Float | Text` for object properties |

Design properties:
- `RulesPackage.id` is private, immutable after construction, accessed via `id()` getter
- Presentation metadata (HUD config) excluded from core — lives in UI layer
- `Custom` prerequisites are verifier-only; `all_mechanical_prerequisites_met()` skips them
- Team-scoped checks (`MinTeams`, `MinCharactersPerTeam`, `MinCharactersOnTeams`) evaluate against the package's declared teams, not stray board teams
- `WorldSnapshot` has no denormalized aggregates — `tile_counts()`, `characters_per_team()`, `teams_with_characters()` are derived methods
- 13 unit tests covering all prerequisite variants, verification semantics, serialization

### Runtime Asset Merge

- `loadAssetBlobs()` in zap-engine accepts `preloadedBlobs` — skips fetch for pre-loaded atlas names
- `loadMergedRegistry()` combines seed manifest with IDB baked character atlases
- InfiniteCanvas loads merged registry on mount and on `character-assets-changed` events
- Generation counter prevents stale async results
- Engine restarts only when baked character set actually changes

---

## Remaining Steps

### Divergence #2: Sandbox AI Preview

**Problem:** AI scripts currently require an active `game_session`. `run_scripts()` returns immediately when `game_session` is None. The vision says AI should preview in sandbox without formal game activation.

**Solution:** Add a lightweight sandbox execution mode:

1. **New function `run_sandbox_ai()`** in `wasm-canvas/src/lib.rs`
   - Runs when `game_session` is None (sandbox mode)
   - Iterates `self.characters` (renderer actors) directly
   - Builds a lightweight `GameView` from canvas actors (no session required)
   - Uses `AiScriptEngine.run_update()` with same `CharacterAiContext`
   - Applies `AiCommand` directly to renderer actors (same as current play-mode apply)
   - No `UnitDamaged`/`UnitKilled` events (no session to emit into)
   - Attack in sandbox is visual-only (animation, no HP drain)

2. **Sandbox GameView construction**
   - Build `GameView` from `self.characters` values
   - Team IDs from `actor.tag` ("team_0", "team_1")
   - Stats from actor health (hp/max_hp only)
   - No `CharacterInstance` needed — pure renderer-level data

3. **Execution routing in `update()` tick**
   - If `game_session.is_some()` → `run_scripts()` (current path, session-authoritative)
   - If `game_session.is_none()` → `run_sandbox_ai()` (new path, renderer-level)

4. **UI signal**
   - React can enable/disable sandbox AI preview via a toggle
   - When disabled, sandbox characters are fully inert (current behavior)
   - When enabled, scripted characters animate and move without game rules

**Files:**
- `infrastructure/wasm-canvas/src/lib.rs` — `run_sandbox_ai()`, routing in `update()`
- Possibly a new WASM export to toggle sandbox AI mode from React

### Divergence #1: World Gen Timing

**Problem:** World gen currently runs inside `start_game_session()`. The vision says it belongs to sandbox/setup — it's an authoring tool, not a play-start action.

**Solution:** Extract world gen into a standalone sandbox operation:

1. **New WASM export: `run_world_gen(script_name: &str)`**
   - **Rejects execution when a play session is active.** The WASM export checks
     `self.game_session.is_some()` and returns an error/no-op if true. World gen
     is a sandbox-only operation — it must not run during `GAME ON`.
   - The React UI disables the trigger button when play is active (defense in depth),
     but the WASM boundary is the authoritative enforcement point.
   - Runs `WorldGenScriptEngine.run_generate()`
   - Applies `WorldGenCommand`s to the live board
   - Tiles placed are durable (authored state, not ephemeral)
   - Characters spawned are board actors (not session instances)

2. **Remove world gen from `start_game_session()`**
   - Play start no longer runs world gen
   - If the user wants procedural setup before playing, they run world gen explicitly first
   - Pre-flight validation **no longer checks** `world_gen_script`. World gen is a sandbox
     authoring tool — its absence or compilation failure does not block `GAME ON`.
     Only `rules_script`, team controller scripts, and per-character AI scripts gate activation.

3. **Persistence and undo semantics**
   - World gen output is part of authored state — persisted on auto-save
   - World gen is an authoring action, so it participates in the editor undo stack
     (same as drawing tiles or placing characters)
   - **Rerun behavior is an open product decision.** Options:
     - Replace: clear all world-gen-produced content, then regenerate
     - Append: add new content without removing previous output
     - Region-scoped: apply only within a selected area
     - Clear-then-regenerate: explicit "clear world gen output" action + separate "run"
   - The implementation should not lock in destructive overwrite. The first version
     should push world gen edits onto the undo stack so they are reversible.
     The rerun/merge strategy will be decided after the basic flow is usable.

4. **UI integration**
   - Button in Script Panel or toolbar: "Run World Gen"
   - Requires a world_gen script to be selected/compiled
   - Shows result count ("placed 25 tiles, spawned 3 characters, defined 2 zones")

**Files:**
- `infrastructure/wasm-canvas/src/lib.rs` — new WASM export, remove from play start
- `ui/web/src/freedom-board/components/FBToolbar.tsx` or `ScriptPanel.tsx` — trigger button
- Engine worker message handler for `run_world_gen`

### Rules Package Integration

**Problem:** The `RulesPackage` domain model exists in core but is not yet wired into the product.

**Steps:**

1. **Verifier Rhai context** (adapters)
   - `VerifierContext` wrapping `WorldSnapshot` for read-only inspection
   - Entry point: `fn verify(ctx)` returns structured pass/fail
   - Registered functions: query characters, objects, zones, tiles by position/type/team
   - `fail(ctx, message)` and `warn(ctx, message)` to emit `VerificationFailure`

2. **WorldSnapshot builder** (infrastructure)
   - Build `WorldSnapshot` from `FreedomBoardGame` state
   - Characters from `self.characters`
   - Objects: requires object system (not yet implemented)
   - Zones: from world binding or previously-defined zones
   - Tiles: iterate `SparseWorld` chunks

3. **Activation flow** (infrastructure + UI)
   - Replace raw `GameDefinition` with `RulesPackage` in the play-start path
   - Run mechanical prerequisite check → show results in UI
   - If verifier exists, run it → show pass/fail with failure messages
   - If all pass → activate (GAME ON)
   - If any error → block with explanation

4. **Rules Editor extension** (UI)
   - Prerequisite editor section (add/remove declarative prerequisites)
   - Verifier script assignment
   - Package metadata (id, name, description)
   - Save `RulesPackage` to IDB (new store or extend `game_defs`)

5. **IDB persistence**
   - `RulesPackage` serialized as JSON in IDB
   - Migration from existing `GameDefinition` saves: wrap in minimal package

### Play HUD and Activation Surface

1. **HUD component** — shows phase, clock, team resources, scores (read from UI-layer config keyed by package id)
2. **Activation feedback** — prerequisite checklist with checkmarks, ready/blocked state
3. **GAME ON transition** — visual indicator, enable rules execution
4. **Pause button** — explicit, independent of panel switches
5. **Error surface** — compile errors, runtime script errors, verification failures shown in UI

### Combat Depth

1. **Weapon stats** — replace `calculate_damage(10)` with template weapon lookup
2. **Damage formula** — configurable via rules script or stat-based
3. **Ranged attacks** — projectile model, range check
4. **Combat feedback** — damage numbers, hit/miss indication

---

## Architecture Invariants

These hold across all remaining work:

- Scripts never mutate state directly — they emit commands
- Three scopes remain isolated — AI cannot spawn, rules cannot move, world gen cannot modify resources
- Core knows nothing about Rhai, WASM, or UI
- Dependency rule: infrastructure → adapters → core
- `WorldSnapshot` is the verification boundary DTO (read-only, no live state)
- `RulesPackage.id` is stable identity for cross-layer references
- Sandbox AI and GAME ON AI use the same `AiScriptEngine` — different context construction, same execution
- World gen in sandbox modifies durable authored state; world gen during GAME ON (if ever reintroduced) would be ephemeral

---

## Priority Order

1. ~~Divergence #3: Rules Package domain model~~ — DONE
2. Divergence #2: Sandbox AI preview
3. Divergence #1: World gen timing extraction
4. Rules Package integration (verifier context, snapshot builder, activation flow)
5. Play HUD and activation surface
6. Combat depth
