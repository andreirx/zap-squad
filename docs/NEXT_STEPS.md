# Next Steps

This document tracks the remaining work for the current product direction.

The direction is:
- one unified web app
- Freedom Board as the primary runtime/editor surface
- source-asset editors as supporting tools
- local-first persistence
- game rules authoring and scripted gameplay as the next product milestone

Support code that is not exposed as a finished feature remains incomplete.

---

## Current State (2026-03-24)

### Complete (support + user-facing feature)

- **Freedom Board** — main route, infinite canvas, sparse world, multi-layer tiles,
  feathered rendering, character placement/movement, A* pathfinding with terrain costs,
  undo/redo, auto-save to IDB, world list modal, save/load to disk.
- **Editors** — Tile, Character, Object, Map editors all authoring assets via IDB.
- **Persistence** — IDB v3 (6 stores), IdbStorage gateway, auto-save, explicit disk save/load,
  asset export/import.
- **Path connectivity** — Land paths cross-connect across types, water paths type-strict,
  bridges over impassable terrain.
- **Atlas baking + feathering** — `bake-atlases.ts`, `wasm-feather` WASM crate.
- **Game rules domain model** — GameDefinition, GameSession, GameMode, GamePhase, teams,
  stats, resources, character templates, events, validation. 147 core tests.
- **Game Rules Editor** — `/editor/rules` with 10 sections, typed serde-compatible
  serialization, complete world binding form, character templates, win conditions.
- **WASM validation bridge** — `wasm-validator` crate (174KB), authoritative Rust validation
  surfaced in the Rules Editor.

### Support-complete but not feature-complete

- **Three-scope script DTOs** — CharacterAiContext, RulesContext, WorldGenContext with
  command/context types. Rust methods defined but not registered in Rhai.
- **GameSession lifecycle** — from_definition, phase transitions, turn rotation, event queue.
  No WASM code creates or drives a session.
- **GameEvent system** — 18 event types. No code emits events into the queue.
- **Combat use case** — apply_damage, calculate_damage with 6 tests.
  No targeting UI, no combat feedback.
- **Legacy scripting** — ScriptEngine, hot reload, per-frame AI execution. Uses old
  ScriptContext/ActorId path, not three-scope architecture.

### Not started

- Script Editor UI
- WASM orchestrator (game session runtime)
- Play Mode
- Combat UX
- Group commands (multi-select, commander/follower)
- Canvas-based zone editor (form-based exists)

---

## Plan

### Next Product Milestone: "Playable Scripted Game on Freedom Board"

A kid can define game rules, write scripts, press Play, and watch characters
behave according to the rules they authored.

---

### Phase A: Orchestrator Skeleton (architectural spine)

**Goal:** Prove the hardest boundary — load a GameDefinition into the Freedom Board
runtime, create a GameSession, execute rules scripts, and apply commands end to end.

**Tasks:**
1. Add `GameSession` field to `FreedomBoardGame` in wasm-canvas
2. New WASM export: `load_game_definition(json)` — parse, store, create session
3. Build `CharacterInstanceId <-> ActorId` mapping layer
4. Emit `GameStart` and `Tick` events into the session EventQueue
5. Register `RulesContext` as a Rhai type with all cmd_* and query_* methods
6. Execute rules script on each event, collect `RulesCommand`s
7. Apply commands: `SpawnUnit`, `KillUnit`, `ModifyStat`, `ModifyResource`, `SetPhase`, `EndGame`
8. Add `start_game()` / `stop_game()` WASM exports
9. Add Play/Stop controls in Freedom Board toolbar
10. Validation gate before start (call wasm-validator, show failures)

**Done when:**
- A saved GameDefinition with a rules script can run in the Freedom Board
- `GameStart` fires, rules script responds, commands apply to session state
- Play/Stop works without crashes

---

### Phase B: Script Editor UI

**Goal:** Give kids a surface to write and test scripts.

**Tasks:**
1. New panel or route for script editing
2. Scope tabs: Character AI / Rules / World Gen
3. Script list by name, textarea editor
4. Compile button with error output (from ScriptEngine.compile_script)
5. Save scripts to IDB
6. Wire reload to WASM via `reload_scripts()` export
7. Status display: loaded / compile failed / active

**Done when:**
- A kid can write a rules script, save it, load it into the Freedom Board, and see it execute
- Compilation errors are displayed in the UI, not just in the console

---

### Phase C: Character AI Migration

**Goal:** Replace legacy ScriptContext/ScriptCommand/ActorId execution path with
the three-scope CharacterAiContext/AiCommand/CharacterInstanceId path.

**Tasks:**
1. Register `CharacterAiContext` in Rhai with all cmd_* and query methods
2. Bridge current scripted actor loop from legacy `ScriptContext` to `CharacterAiContext`
3. Populate `GameView` snapshot for AI scripts from live session state
4. Map AiCommand output back through CharacterInstanceId → ActorId for rendering
5. Preserve current movement/animation functionality
6. Retire legacy `ScriptContext` execution path

**Done when:**
- Characters execute AI scripts through the new context
- `find_nearest_enemy`, stat queries, and movement all work
- Legacy ScriptContext path can be removed

---

### Phase D: World Generation Scripting

**Goal:** World gen scripts populate the map during Setup phase.

**Tasks:**
1. Register `WorldGenContext` in Rhai
2. Run `world_gen_script` during `GamePhase::Setup`
3. Apply `PlaceTile` → SparseWorld mutation
4. Apply `SpawnUnit` → character placement
5. Apply `DefineZone` → WorldBinding zone creation (map zone_type string to ZoneType enum)
6. Transition to Exploration phase after world gen completes

**Done when:**
- A world gen script creates terrain, spawns units, and defines zones
- The game starts from an empty board and builds itself

---

### Phase E: Play Mode Polish

**Goal:** The game session is understandable and controllable.

**Tasks:**
1. GameHUD: team resources, turn indicator, current phase, active team
2. Pause/Resume during play
3. Mode-specific flow: TurnBased turn rotation, Tactical encounter auto-pause
4. Win/lose detection and display
5. Session reset (stop game, return to edit mode)

**Done when:**
- A kid can see what's happening (whose turn, what resources, what phase)
- The game ends when win conditions are met

---

### Phase F: Combat Feature Layer

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

### Phase G: Group Commands

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

1. **Orchestrator skeleton** — the architectural spine that connects everything
2. **Script Editor UI** — the authoring surface for scripts
3. **Character AI migration** — new scope replaces legacy
4. **World gen scripting** — game = world + rules from authored data
5. **Play Mode polish** — HUD, pause, win/lose
6. **Combat UX** — targeting, feedback, events
7. **Group commands** — multi-select, squads
