# Scripting Architecture

## Overview

ZapSquad uses [Rhai](https://rhai.rs/) (v1.19, `sync` feature) as its scripting language.
Rhai was chosen (ADR-003) because it is Rust-native, WASM-compatible, sandboxed (no file/network
access), and has beginner-friendly syntax suitable for kids learning to program game logic.

The scripting system has **three isolated scopes**, each with its own context type,
command enum, and execution timing. Scripts never mutate game state directly — they
emit commands that the orchestrator applies after execution completes.

```
┌────────────────────────────────────────────────────────────────┐
│                        CORE LAYER                              │
│  entities/game_rules/                                          │
│    GameDefinition  ─── references scripts by name              │
│    GameSession     ─── owns EventQueue                         │
│    GameEvent       ─── typed events for script consumption     │
│    CharacterInstance ── optional ai_script field               │
└──────────────────────────────┬─────────────────────────────────┘
                               │ depends inward
┌──────────────────────────────▼─────────────────────────────────┐
│                      ADAPTERS LAYER                            │
│  script_bindings.rs                                            │
│    ScriptEngine    ─── Rhai Engine + compiled AST cache        │
│    ScriptContext    ─── per-character context for AI scripts   │
│    ScriptCommand   ─── MoveTo, Attack, SetDirection, ...       │
│    WorldQuery      ─── read-only snapshot of all actors        │
│                                                                │
│  game_script_bindings.rs                                       │
│    CharacterAiContext ── per-character, per-frame behavior     │
│    RulesContext       ── game-level event handling             │
│    WorldGenContext    ── setup-time world creation             │
│    AiCommand         ── movement + combat commands             │
│    RulesCommand      ── spawn, kill, modify stats/resources    │
│    WorldGenCommand   ── place tiles, spawn units, define zones │
│    GameView / CharacterView / TeamView ── read-only DTOs       │
└──────────────────────────────┬─────────────────────────────────┘
                               │ depends inward
┌──────────────────────────────▼─────────────────────────────────┐
│                   INFRASTRUCTURE LAYER                         │
│  wasm-canvas/src/lib.rs                                        │
│    FreedomBoardGame ── owns ScriptEngine instance              │
│    PENDING_SCRIPTS  ── thread_local hot-reload queue           │
│    reload_scripts() ── WASM export for React → WASM            │
│    run_scripts()    ── per-frame script execution loop         │
│    Orchestrator     ── LIVE: drives GameSession + rules scope   │
│                        (AI = legacy path, world gen = deferred) │
└────────────────────────────────────────────────────────────────┘
```

## The Three Scopes

### 1. Character AI Scripts

**Purpose:** Per-character behavior each frame. A character's AI script controls
where it moves, what it attacks, and what animation it plays.

**Execution timing:** Every frame (dt ≈ 1/60s) for each character that has an `ai_script`.

**Context:** `CharacterAiContext` (from `game_script_bindings.rs`)
- `self_id` → u32 — my CharacterInstanceId
- `self_team` → u32 — my team
- `self_pos` → Vec2 — my position
- `self_stats` → HashMap<String, f32> — my current stats
- `dt` → f32 — delta time
- `game` → GameView — read-only snapshot of all teams and characters

**Commands:** `AiCommand` enum
- `MoveTo(Vec2)` — smooth pathfinding movement
- `Attack(CharacterInstanceId)` — target an enemy
- `Face(String)` — face a direction ("north", "south", "east", "west")
- `SetAnimation(String)` — set animation state ("idle", "walk", "melee", "throw")
- `SetVelocity(Vec2)` — override movement system
- `PlaySound(String)` — audio cue (placeholder)

**Sandbox constraints:** Can query game state read-only via GameView. Cannot modify
game state, resources, other characters' stats, or game phase. Only controls its own
movement and animation.

**Note on legacy bindings:** `script_bindings.rs` contains an older `ScriptContext` /
`ScriptCommand` / `ActorId`-based system that is currently wired into `wasm-canvas`
for per-frame execution. The `CharacterAiContext` / `AiCommand` / `CharacterInstanceId`
system in `game_script_bindings.rs` is the target architecture. The orchestrator (Phase 3)
will migrate execution from the legacy path to the new one.

**Script entry point:**
```rhai
fn update(ctx) {
    let enemy = find_nearest(ctx, "enemy");
    if enemy >= 0 {
        let pos = get_position(ctx, enemy);
        let me = self_pos(ctx);
        if dist_vec(me, pos) < 50.0 {
            attack(ctx, enemy);
        } else {
            move_to(ctx, pos.x, pos.y);
        }
    }
}
```

### 2. Rules Scripts

**Purpose:** Game-level logic responding to events. Handles resource ticking, win
condition checking, phase transitions, unit spawning, and custom game mechanics.

**Execution timing:** Per-event. The orchestrator drains the GameSession EventQueue
and calls the rules script for each event.

**Context:** `RulesContext` (from `game_script_bindings.rs`)
- `query_team_resource(team_id, key)` → f64
- `query_unit_stat(char_id, key)` → f64
- `query_alive_count(team_id)` → i64
- `query_phase()` → String
- `query_clock()` → f64
- `query_turn()` → i64

**Commands:** `RulesCommand` enum
- `SpawnUnit { template_id, team_id, x, y, individual }` — create a character instance
- `KillUnit { character_id }` — remove a character
- `ModifyStat { character_id, stat_key, delta }` — adjust stat by amount
- `SetStat { character_id, stat_key, value }` — set stat to exact value
- `ModifyResource { team_id, resource_key, delta }` — adjust team resource
- `SetPhase(String)` — transition game phase
- `EndGame { winner_team_id }` — declare winner
- `EmitEvent { name, data }` — custom event for pub/sub
- `Log(String)` — debug output

**Sandbox constraints:** Full game mutation via commands. Cannot directly move characters
or modify the spatial world. Issues commands that the orchestrator applies to the
mutable GameSession.

**Event types** (`GameEvent` enum in `core/entities/game_rules/event.rs`):
```
GameStart                                                    — world ready, teams initialized
Tick { dt: f32 }                                             — real-time frame update
TurnStart { team: TeamId, turn_number: u32 }                 — discrete turn begins (TurnBased)
TurnEnd { team: TeamId, turn_number: u32 }                   — turn ends
EncounterTriggered { teams: (TeamId, TeamId) }               — Tactical: two teams contact
PlanningStart / PlanningEnd                                  — tactical encounter decision phase
ResolutionStart / ResolutionEnd                              — tactical encounter resolution
EncounterResolved                                            — encounter over, return to Exploration
UnitSpawned { character_id: CharacterInstanceId, team: TeamId }
UnitDamaged { character_id, attacker_id: Option<CharacterInstanceId>, damage: f32, remaining_hp: f32 }
UnitKilled { character_id, killer_id: Option<CharacterInstanceId> }
StatChanged { character_id, stat_key: String, old_value: f32, new_value: f32 }
ResourceChanged { team: TeamId, resource_key: String, old_value: f32, new_value: f32 }
WaveStart { wave_number: u32 }
WaveComplete { wave_number: u32 }
ZoneEntered { character_id: CharacterInstanceId, zone_id: String }
ZoneExited { character_id: CharacterInstanceId, zone_id: String }
Custom { name: String, data: Stats }                         — script-emitted for pub/sub
```

### 3. World Generation Scripts

**Purpose:** Setup-time world creation. Runs once during `GamePhase::Setup` to
populate the map with tiles, spawn initial units, and define game zones.

**Execution timing:** Once, before any gameplay starts.

**Context:** `WorldGenContext` (from `game_script_bindings.rs`)
- No query APIs (empty world at setup time)

**Commands:** `WorldGenCommand` enum
- `PlaceTile { x, y, asset_id, layer, variant }` — add tile to SparseWorld
- `SpawnUnit { template_id, team_id, x, y }` — place starting character
- `DefineZone { name, x, y, width, height, zone_type, team_id }` — create game zone
- `Log(String)` — debug output

**Known debt:** `DefineZone` carries `zone_type` as String and `team_id` as `Option<u32>`.
The orchestrator must map the string to the `ZoneType` enum. See `docs/game-rules-debt.md`.

## Execution Path: End to End

### Phase A: Script Text → WASM

```
Script Panel (IDB scripts store)
    │
    ├── User edits script in textarea
    ├── Saves to IDB: scriptStore.save(name, source, scope)
    │
    ▼  Reload button
JavaScript: JSON.stringify({
    "my_rules": { "source": "fn on_event(ctx) { ... }", "scope": "rules" },
    "patrol_ai": { "source": "fn update(ctx) { ... }", "scope": "character_ai" }
})
    │  (editor buffer overlaid for dirty scripts — WASM runs what user sees)
    ▼
WASM export: reload_scripts(json_string)
    │  [wasm-canvas/src/lib.rs]
    │  Parses JSON into HashMap<String, PendingScript>
    │  PendingScript = { source: String, scope: String }
    │  Stores in thread_local PENDING_SCRIPTS
    ▼
(Queued — not compiled yet)
```

### Phase B: Compilation (Next Game Tick)

```
FreedomBoardGame::update()
    │
    ├── Check PENDING_SCRIPTS thread_local
    │   If Some(scripts):
    │     ├── self.scripts.clear_scripts()           — wipe old AI ASTs
    │     ├── self.rules_engine.clear_scripts()      — wipe old rules ASTs
    │     ├── For each (name, entry):
    │     │     match entry.scope:
    │     │       "character_ai" → self.scripts.compile_script(name, source)
    │     │       "rules"        → self.rules_engine.compile_script(name, source)
    │     │       "world_gen"    → skipped (Track D — WorldGenContext not yet wired)
    │     │       _              → warning logged
    │     │     └── Engine::compile(source) → AST
    │     │         Stored in HashMap<String, CompiledScript> per engine
    │     └── Log success/failure counts per scope
    │
    └── Continue to run_scripts()
```

**Key detail:** Scripts are compiled to Rhai AST once and cached. Execution uses the
pre-compiled AST — no string eval at runtime.

### Phase C: Per-Frame Execution (Character AI)

```
FreedomBoardGame::run_scripts()
    │
    ├── Collect all actors with script_id ≠ None
    ├── Build WorldQuery { actors: Vec<(ActorId, Vec2, String)> }
    │   (snapshot of all actor positions and tags)
    │
    ├── For each scripted actor:
    │   ├── [CURRENT — legacy path via script_bindings.rs]
    │   │   Create ScriptContext { self_id, self_pos, dt, world: WorldQuery }
    │   │   → Engine::call_fn(&ast, "update", (ctx,))
    │   │   → ctx.take_commands() → Vec<ScriptCommand>
    │   │
    │   ├── [TARGET — via game_script_bindings.rs, orchestrator Phase 3]
    │   │   Create CharacterAiContext { self_id, self_team, self_pos, self_stats, dt, game: GameView }
    │   │   → Engine::call_fn(&ast, "update", (ctx,))
    │   │   → ctx.take_commands() → Vec<AiCommand>
    │
    └── Apply all commands:
        ├── MoveTo → insert into movement_targets HashMap
        │   (A* pathfinding runs, waypoint queue populated)
        ├── Attack → apply_damage(), set MeleeAttack animation
        ├── SetDirection → update CompositeActor.direction
        ├── SetAnimation → update CompositeActor.animation_state
        └── SetVelocity → override velocity directly
```

### Phase D: Event-Driven Execution (Rules Scripts) — LIVE (2026-03-26)

```
FreedomBoardGame::run_orchestrator(dt)   [wasm-canvas/src/lib.rs]
    │
    ├── Push Tick { dt } event to GameSession
    ├── GameSession.events.drain()
    │   └── For each GameEvent:
    │       ├── event_to_dto() → (event_name, event_data, event_strings)
    │       ├── Create RulesContext {
    │       │     game: GameView (read-only snapshot),
    │       │     event_name, event_data, event_strings,
    │       │     commands: Vec<RulesCommand>
    │       │   }
    │       ├── rules_engine.run_on_event(script_name, ctx)
    │       │   └── Engine::call_fn(&ast, "on_event", (ctx,))
    │       └── ctx.take_commands() → Vec<RulesCommand>
    │
    └── apply_rules_command() for each command:
        ├── SpawnUnit → CharacterInstance::from_template(), CompositeActor,
        │               actor_to_instance mapping
        ├── KillUnit → mark dead, remove actor, clean up mapping
        ├── ModifyStat → CharacterInstance.modify_stat()
        ├── SetStat → CharacterInstance.set_stat()
        ├── ModifyResource → TeamState.resources mutation
        ├── SetPhase → GameSession.phase transition
        ├── EndGame → GameSession.phase = Ended { winner }
        ├── EmitEvent → push Custom event to GameSession.events
        └── Log → web_sys::console::log_1
```

### Phase E: World Generation — FUTURE

```
GamePhase::Setup
    │
    ├── Create WorldGenContext { commands: Vec<WorldGenCommand> }
    ├── Engine::call_fn(&worldgen_ast, "generate", (ctx,))
    ├── ctx.take_commands()
    │
    └── Apply:
        ├── PlaceTile → SparseWorld.set(x, y, layer, tile)
        ├── SpawnUnit → place starting characters
        └── DefineZone → add to WorldBinding.zones
```

## ScriptEngine Internals

### Struct

```rust
pub struct ScriptEngine {
    engine: Engine,                              // Rhai interpreter instance
    scripts: HashMap<String, CompiledScript>,    // AST cache
}

pub struct CompiledScript {
    pub ast: AST,       // Pre-compiled Rhai AST
    pub name: String,   // Script identifier
}
```

### Registered Types (Legacy — script_bindings.rs)

These are registered in the current `ScriptEngine::new()` and used by the legacy
per-frame execution path in wasm-canvas:

| Rhai Name | Rust Type | Properties |
|-----------|-----------|------------|
| `Vec2` | `glam::Vec2` | `.x`, `.y` (get/set, f64↔f32 conversion) |
| `ActorId` | `ActorId(u32)` | Opaque, passed as i64 |
| `Context` | `ScriptContext` | Passed to `update(ctx)` |

### Registered Functions (Legacy — script_bindings.rs)

| Function | Signature | Category |
|----------|-----------|----------|
| `move_to` | `(ctx, x: f64, y: f64)` | Command |
| `attack` | `(ctx, target_id: i64)` | Command |
| `face` | `(ctx, direction: &str)` | Command |
| `set_animation` | `(ctx, state: &str)` | Command |
| `set_velocity` | `(ctx, x: f64, y: f64)` | Command |
| `play_sound` | `(ctx, name: &str)` | Command |
| `find_nearest` | `(ctx, tag: &str) → i64` | Query |
| `get_position` | `(ctx, id: i64) → Vec2` | Query |
| `self_pos` | `(ctx) → Vec2` | Query |
| `self_id` | `(ctx) → i64` | Query |
| `dt` | `(ctx) → f64` | Query |
| `dist` | `(x1, y1, x2, y2) → f64` | Utility |
| `dist_vec` | `(a: Vec2, b: Vec2) → f64` | Utility |
| `normalize` | `(x, y) → Vec2` | Utility |
| `lerp` | `(a, b, t) → f64` | Utility |
| `vec2` | `(x, y) → Vec2` | Constructor |

### Target API (game_script_bindings.rs — not yet registered in Rhai)

The context types in `game_script_bindings.rs` define Rust methods that will be
registered as Rhai functions when the orchestrator (Phase 3) creates a new `Engine`
instance. These are **not yet registered** — they exist as Rust methods only.

**CharacterAiContext methods:**
- `cmd_move_to(x, y)`, `cmd_attack(target_id)`, `cmd_face(direction)`
- `cmd_set_animation(state)`, `cmd_set_velocity(x, y)`, `cmd_play_sound(name)`
- `find_nearest_enemy() → (f64, f64)`, `get_pos(instance_id) → (f64, f64)`

**RulesContext methods:**
- `cmd_spawn(template_id, team_id, x, y)`, `cmd_spawn_individual(template_id, team_id, x, y)`
- `cmd_kill(character_id)`, `cmd_modify_stat(character_id, stat_key, delta)`
- `cmd_set_stat(character_id, stat_key, value)`, `cmd_modify_resource(team_id, resource_key, delta)`
- `cmd_end_game(winner_team_id)`, `cmd_log(msg)`
- `query_team_resource(team_id, key)`, `query_unit_stat(character_id, key)`
- `query_alive_count(team_id)`, `query_phase()`, `query_clock()`, `query_turn()`

**WorldGenContext methods:**
- `cmd_place_tile(x, y, asset_id, layer, variant)`
- `cmd_spawn(template_id, team_id, x, y)`
- `cmd_define_zone(name, x, y, width, height, zone_type, team_id)`
- `cmd_log(msg)`

### Compilation & Caching

- `compile_script(name, source)` → `Engine::compile(source)` → stored as AST
- Compilation errors: `Box<EvalAltResult>` returned to caller, logged to console
- Execution uses cached AST via `Engine::call_fn()` — no string eval
- `clear_scripts()` wipes all cached ASTs (called before hot-reload recompilation)
- Fresh `Scope` per execution — no state persists between frames

### Hot Reload

The hot-reload mechanism decouples script text changes from the game loop:

1. React calls `reload_scripts(json)` via WASM binding
2. JSON parsed to `HashMap<String, String>`, stored in `thread_local PENDING_SCRIPTS`
3. Next `update()` tick: `PENDING_SCRIPTS.take()` → clear old ASTs → recompile all
4. Scripts execute with new ASTs from that tick onward

This prevents mid-update recompilation races. The thread_local queue is the synchronization
point between the JavaScript thread (which calls `reload_scripts`) and the game loop
(which calls `update`).

## Script References in the Domain Model

| Entity | Field | Purpose |
|--------|-------|---------|
| `GameDefinition` | `rules_script: String` | Name of the rules Rhai script |
| `GameDefinition` | `world_gen_script: Option<String>` | Optional world setup script |
| `CharacterInstance` | `ai_script: Option<String>` | Per-character AI behavior |
| `TeamDefinition` | `controller: Cpu { script_name }` | Team-level AI script |

Scripts are referenced by **name** (string key). The `ScriptEngine` stores compiled ASTs
keyed by name. The orchestrator resolves names to ASTs at execution time.

**Known gap:** Validation does not check that referenced script names actually exist as
compiled ASTs. This should be an orchestrator pre-flight check at game start.

## Architectural Invariants

1. **Scripts never mutate state directly.** They emit commands. The orchestrator applies them.
2. **Three scopes are isolated.** AI scripts cannot spawn units. Rules scripts cannot move
   characters. World gen scripts cannot modify resources.
3. **The Command pattern is the mutation boundary.** All side effects cross through command
   enums that the orchestrator interprets.
4. **Core knows nothing about Rhai.** The core layer defines `GameEvent`, `GameSession`,
   `CharacterInstance` — all pure Rust types. Rhai lives in adapters.
5. **Hot reload is safe.** Scripts are recompiled atomically between ticks, not during execution.
6. **Scripts are sandboxed.** Rhai has no filesystem, network, or FFI access. Only registered
   functions are callable.

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| ScriptEngine (compile, cache, execute) | DONE | `adapters/script_bindings.rs` — legacy API |
| Legacy AI execution (ScriptContext/ScriptCommand) | DONE | Wired in wasm-canvas `run_scripts()` |
| Hot reload (PENDING_SCRIPTS → recompile) | DONE | `reload_scripts()` WASM export |
| Three-scope command/context DTOs | DONE | `game_script_bindings.rs` — Rust methods defined |
| Game event system (GameEvent enum) | DONE | `core/entities/game_rules/event.rs` |
| Game rules editor + validation | DONE | `ui/web/src/editors/RulesEditor/` + `wasm-validator` |
| Rhai registration for three-scope API | NOT STARTED | Orchestrator must register context types + functions |
| CharacterAiContext execution path | NOT STARTED | Replace legacy ScriptContext in orchestrator |
| Rules script execution | NOT STARTED | Needs orchestrator (Phase 3) |
| World gen script execution | NOT STARTED | Needs orchestrator (Phase 3) |
| Script Editor UI | NOT STARTED | Phase 2: textarea with scope tabs |
| Script persistence in IDB | NOT STARTED | Scripts not yet saved to IDB |
| Script existence validation | NOT STARTED | Orchestrator pre-flight check |

## Files

| File | Layer | Role |
|------|-------|------|
| `adapters/src/script_bindings.rs` | Adapters | ScriptEngine, Rhai registration, compile/execute |
| `adapters/src/game_script_bindings.rs` | Adapters | Three-scope contexts, command enums, DTOs |
| `infrastructure/wasm-canvas/src/lib.rs` | Infrastructure | PENDING_SCRIPTS, reload_scripts, run_scripts |
| `core/src/entities/game_rules/event.rs` | Core | GameEvent enum |
| `core/src/entities/game_rules/session.rs` | Core | EventQueue, GameSession lifecycle |
| `core/src/entities/game_rules/character.rs` | Core | CharacterInstance.ai_script field |
| `core/src/entities/game_rules/definition.rs` | Core | GameDefinition script name references |
| `core/src/entities/script.rs` | Core | Script entity (id, name, source) |
