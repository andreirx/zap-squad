# Next Steps

This document tracks the remaining work for the current product direction.

The direction is:
- one unified web app
- Freedom Board as the primary runtime/editor surface
- source-asset editors as supporting tools
- local-first persistence
- game rules authoring and scripted gameplay as the current product milestone

Support code that is not exposed as a finished feature remains incomplete.

---

## Current State (2026-03-29)

### Complete (support + user-facing feature)

- **Freedom Board** — main route, infinite canvas, sparse world, multi-layer tiles,
  feathered rendering, character placement/movement, A* pathfinding with terrain costs,
  undo/redo, auto-save to IDB, world list modal, save/load to disk.
- **Editors** — Tile, Character, Object, Map editors all authoring assets via IDB.
- **Persistence** — IDB v4 (7 stores: assets, levels, worlds, config, files, game_defs,
  scripts), IdbStorage gateway, auto-save, explicit disk save/load, asset export/import.
  Corrupted-state recovery (missing stores → auto-delete and recreate).
- **Path connectivity** — Land paths cross-connect across types, water paths type-strict,
  bridges over impassable terrain.
- **Atlas baking + feathering** — `bake-atlases.ts`, `wasm-feather` WASM crate.
- **Game rules domain model** — GameDefinition, GameSession, GameMode, GamePhase, teams,
  stats, resources, character templates, events, validation. 147 core tests.
- **Game Rules Editor** — `/editor/rules` with 10 sections, typed serde-compatible
  serialization, complete world binding form, character templates, win conditions.
- **WASM validation bridge** — `wasm-validator` crate (174KB), authoritative Rust validation
  surfaced in the Rules Editor.
- **Orchestrator skeleton** — `FreedomBoardGame` owns `GameSession`, `RulesScriptEngine`,
  `CharacterInstanceId↔ActorId` mapping. Loads `GameDefinition` via WASM export, validates
  before start, emits `GameStart`/`Tick` events, drains events through rules script,
  applies `RulesCommand`s (spawn, kill, modify stat/resource, set phase, end game).
  `PrePlaySnapshot` for idempotent start/stop. SESSION_STATE acknowledgment events
  (kind=2) drive React UI authoritatively.
- **Script Panel** — Right sidebar in Freedom Board. Scripts persisted in IDB `scripts`
  store. Create, rename (with dangling-reference warning), delete. Scope-aware
  (rules/character_ai/world_gen). Monospace textarea editor with dirty tracking.
  Reload to WASM via scoped wire format `{ name: { source, scope } }`. Editor buffer
  overlay on reload (WASM runs what the user sees). Error handling on all IDB operations.
  Example scripts (rules + two AI patterns) via Examples button.
- **Play/Stop controls** — FBToolbar Play/Stop buttons. Game definition selector dropdown.
  Edit tools disabled during play. State driven by WASM acknowledgment events.
- **Scoped script routing** — WASM `reload_scripts()` parses scoped format and routes
  `character_ai` → `AiScriptEngine`, `rules` → `RulesScriptEngine`, `world_gen` →
  `WorldGenScriptEngine`. All three scopes compiled and executed.
- **WebGPU rendering** — `force2D` removed. Largest atlas is 2400x1536, under 8192 limit.

### Support-complete but not feature-complete

- **GameEvent system** — 18 event types. `GameStart`, `Tick` emitted by orchestrator.
  Other events (`UnitDamaged`, `UnitKilled`, etc.) emitted by `apply_rules_command`.
- **Combat use case** — `apply_damage`, `calculate_damage` with 6 tests.
  No targeting UI, no combat feedback.

### Complete (2026-03-29)

- **Three-scope script DTOs** — `CharacterAiContext`, `RulesContext`, `WorldGenContext` with
  command/context types. All three registered in Rhai.
- **Character AI** — Migrated to `AiScriptEngine` with legacy-compatible API (`move_to`,
  `attack`, `find_nearest`, etc.). Named scripts from IDB assigned via CharacterPanel.
- **Character script assignment UI** — CharacterPanel dropdown binds named scripts to
  placed characters.
- **World generation execution** — `WorldGenScriptEngine` runs `fn generate(ctx)` during
  session setup. PlaceTile, SpawnUnit, DefineZone, Log commands. Failure aborts startup
  with snapshot rollback.
- **Character AI migration** — AiScriptEngine replaces legacy ScriptContext path in
  Freedom Board.
- **Pre-flight script validation** — `start_game_session()` verifies all referenced scripts
  (rules, world_gen, team AI, per-character AI) are compiled before allowing play. Missing
  scripts abort startup with `start_failed` event.

### Not started

- Play Mode HUD (phase, resources, turns, team indicators)
- Combat UX (targeting, ranged attacks, feedback)
- Group commands (multi-select, commander/follower)
- Canvas-based zone editor (form-based exists in Rules Editor)
- Compile error feedback from WASM to UI (currently console-only)
- Headless orchestrator tests (wasm-canvas has zero tests)

---

## Plan

### Next Product Milestone: "Playable Scripted Game on Freedom Board"

A kid can define game rules, write scripts, press Play, and watch characters
behave according to the rules they authored.

---

### Phase A: Orchestrator Skeleton — COMPLETE (2026-03-26)

Load GameDefinition, validate, create GameSession, emit events, execute rules
script, apply commands, start/stop with snapshot restore. Scoped script routing.
SESSION_STATE acknowledgment events. Script Panel with IDB persistence.

---

### Phase B: Script Editor + Play Controls — COMPLETE (2026-03-26)

Script Panel in Freedom Board sidebar. IDB v4 `scripts` store. Scoped reload
to WASM. Example scripts. Play/Stop toolbar controls. Game definition selector.
Error handling on all IDB operations. WebGPU rendering restored.

---

### Phase C: Character Script Assignment + Play HUD — PARTIAL (2026-03-29)

**Goal:** Connect the existing character AI runtime to named scripts from IDB,
and give the player visible feedback during play mode.

**Tasks:**
1. ~~UI to assign a script name to a placed character (dropdown from `scriptStore.list()`)~~ — DONE
2. ~~Store script_name on character in world state (serialize/deserialize)~~ — DONE
3. ~~WASM reads script_name from character, looks up compiled AST by name~~ — DONE
4. GameHUD component: current phase, game mode, team resources, turn indicator
5. Surface validation/start failures in HUD, not console only
6. Surface script compile errors in Script Panel status

**Done when:**
- ~~A placed character runs its assigned AI script during Play mode~~ — DONE
- The HUD shows phase, resources, and game status
- Compile errors are visible in the Script Panel

---

### Phase D: World Generation Scripting — COMPLETE (2026-03-29)

**Goal:** World gen scripts populate the map during Setup phase.

**Tasks:**
1. ~~Register `WorldGenContext` in Rhai with `place_tile`, `spawn_unit`, `define_zone`, `log`, `rand`, `seed`~~ — DONE
2. ~~Compile `world_gen` scope scripts in WASM~~ — DONE
3. ~~Run `world_gen_script` during `start_game_session()` after pre-flight validation~~ — DONE
4. ~~Apply `PlaceTile` → name→id resolution, SparseWorld mutation, `SpawnUnit` → template-matched placement~~ — DONE
5. ~~Apply `DefineZone` → session.zones (Zone struct)~~ — DONE
6. ~~Transition to Exploration phase after world gen completes~~ — DONE
7. ~~Failure aborts startup and restores pre-play snapshot~~ — DONE

**Done:** A world gen script creates terrain, spawns units, and defines zones.
RNG uses xorshift32, reset to seed 42 before each run.

---

### Phase E: Character AI Migration — COMPLETE (2026-03-29)

**Goal:** Replace legacy `ScriptContext`/`ScriptCommand`/`ActorId` execution path with
`CharacterAiContext`/`AiCommand`/`CharacterInstanceId`.

**Tasks:**
1. ~~Register `CharacterAiContext` in Rhai with all cmd_* and query methods~~ — DONE
2. ~~Bridge from legacy scripted actor loop to `CharacterAiContext`~~ — DONE
3. ~~Populate `GameView` snapshot for AI scripts from live session state~~ — DONE
4. ~~Map `AiCommand` output through `CharacterInstanceId → ActorId` for rendering~~ — DONE
5. ~~Preserve current movement/animation functionality~~ — DONE
6. ~~Retire legacy `ScriptContext` execution path from Freedom Board~~ — DONE (retained for standalone WASM only)

**Done:** Characters execute AI scripts through AiScriptEngine. Legacy ScriptContext
path retired from Freedom Board.

---

### Remaining Debt (2026-03-29)

- **Combat damage is placeholder:** `calculate_damage(10)` — no weapon stats or formulas
- **Compile/runtime errors are console-only:** not surfaced in Script Panel or HUD
- **World gen runs at play-start only:** edit-time preview generation is future work

---

### Phase F: Play Mode Polish

**Goal:** The game session is understandable and controllable.

**Tasks:**
1. Pause/Resume during play
2. Mode-specific flow: TurnBased turn rotation, Tactical encounter auto-pause
3. Win/lose detection and display
4. Session reset (stop game, return to edit mode)
5. Resource/turn HUD polish

**Done when:**
- A kid can see what's happening (whose turn, what resources, what phase)
- The game ends when win conditions are met

---

### Phase G: Combat Feature Layer

**Goal:** Combat becomes a real interactive feature.

**Tasks:**
1. Attack targeting UI (click to select target)
2. Ranged attacks through object assets
3. Range validation and failure feedback
4. Hit/damage/death feedback (visual + event emission)
5. Idle state return after attack animation
6. Events emitted into GameSession.events (UnitDamaged, UnitKilled)

**Done when:**
- A player can command a character to attack a valid target
- Damage, death, and animation all work correctly
- Events fire for rules scripts to react to

---

### Phase H: Group Commands

**Goal:** Multi-character control.

**Tasks:**
1. Multi-select (shift-click, drag box)
2. Group move
3. Spacing / overlap avoidance
4. Commander/follower assignment
5. Follow behavior as a real feature

**Done when:**
- Multiple characters can be selected and moved together
- Followers stay bound to a commander

---

## Immediate Priority Order

1. ~~**Character script assignment**~~ — DONE (AiScriptEngine, CharacterPanel)
2. ~~**World gen scripting**~~ — DONE (WorldGenScriptEngine)
3. ~~**Character AI migration**~~ — DONE (AiScriptEngine replaces legacy)
4. **Play HUD** — show phase, resources, turns, game status
5. **Play Mode polish** — pause, win/lose, mode-specific flow
6. **Combat UX** — targeting, feedback, events
7. **Group commands** — multi-select, squads
8. **Headless orchestrator tests** — wasm-canvas test seam
