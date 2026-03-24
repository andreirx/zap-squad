# Rhai Scripting API Reference

This document is the authoritative reference for the Rhai scripting API available
to game scripts in ZapSquad. It describes every function, property, and type that
scripts can use, organized by scope.

## Script Scopes

ZapSquad has three isolated scripting scopes. Each scope has its own Rhai Engine
instance with a different set of registered functions. A function available in one
scope is not available in another.

| Scope | Entry Point | When It Runs | Context Type |
|-------|-------------|--------------|--------------|
| Rules | `fn on_event(ctx)` | Per game event (GameStart, Tick, etc.) | `RulesCtx` |
| Character AI | `fn update(ctx)` | Every frame per scripted character | `Context` (legacy) |
| World Gen | `fn generate(ctx)` | Once during Setup phase | `WorldGenCtx` (future) |

---

## Rules Scripts

Rules scripts handle game-level logic: resource management, unit spawning/killing,
phase transitions, win condition checking, and custom game mechanics.

### Entry Point

```rhai
fn on_event(ctx) {
    let name = ctx.event_name;
    if name == "GameStart" {
        cmd_log(ctx, "Game has started!");
    }
}
```

The orchestrator calls `on_event(ctx)` once per game event. The `ctx` parameter
is a `RulesCtx` object containing the game state snapshot and event metadata.

### Event Metadata

| Function / Property | Returns | Description |
|---------------------|---------|-------------|
| `ctx.event_name` | `String` | Event type: "GameStart", "Tick", "TurnStart", etc. |
| `event_data(ctx, key)` | `f64` | Numeric event parameter. Returns 0.0 if key not found. |
| `event_string(ctx, key)` | `String` | String event parameter. Returns "" if key not found. |

### Event Types

| Event Name | Numeric Data (via `event_data`) | String Data (via `event_string`) |
|------------|-------------------------------|----------------------------------|
| `GameStart` | — | — |
| `Tick` | `dt` (delta time in seconds) | — |
| `TurnStart` | `team_id`, `turn_number` | — |
| `TurnEnd` | `team_id`, `turn_number` | — |
| `EncounterTriggered` | `team_a`, `team_b` | — |
| `PlanningStart` | — | — |
| `PlanningEnd` | — | — |
| `ResolutionStart` | — | — |
| `ResolutionEnd` | — | — |
| `EncounterResolved` | — | — |
| `UnitSpawned` | `character_id`, `team_id` | — |
| `UnitDamaged` | `character_id`, `attacker_id`, `damage`, `remaining_hp` | — |
| `UnitKilled` | `character_id`, `killer_id` | — |
| `StatChanged` | `character_id`, `old_value`, `new_value` | `stat_key` |
| `ResourceChanged` | `team_id`, `old_value`, `new_value` | `resource_key` |
| `WaveStart` | `wave_number` | — |
| `WaveComplete` | `wave_number` | — |
| `ZoneEntered` | `character_id` | `zone_id` |
| `ZoneExited` | `character_id` | `zone_id` |
| `Custom` | (user-defined) | `custom_name` |

### Command Functions

Commands are how scripts mutate game state. They are collected during script
execution and applied by the orchestrator after the script returns.

| Function | Parameters | Description |
|----------|-----------|-------------|
| `cmd_spawn(ctx, template_id, team_id, x, y)` | `String, i64, f64, f64` | Spawn a fungible character from template at position. |
| `cmd_spawn_individual(ctx, template_id, team_id, x, y)` | `String, i64, f64, f64` | Spawn a persistent individual (has XP, permadeath). |
| `cmd_kill(ctx, character_id)` | `i64` | Kill a character. Removes from board. |
| `cmd_modify_stat(ctx, character_id, stat_key, delta)` | `i64, String, f64` | Add delta to a character's stat (e.g., -30 to hp). |
| `cmd_set_stat(ctx, character_id, stat_key, value)` | `i64, String, f64` | Set a character's stat to an exact value. |
| `cmd_modify_resource(ctx, team_id, resource_key, delta)` | `i64, String, f64` | Add delta to a team's resource (e.g., +10 gold). |
| `cmd_end_game(ctx, winner_team_id)` | `i64` | End the game. Pass -1 for a draw (no winner). |
| `cmd_log(ctx, message)` | `String` | Print to browser console (prefixed `[rules]`). |

### Query Functions

Queries read game state without modifying it. All return values, never mutate.

| Function | Parameters | Returns | Description |
|----------|-----------|---------|-------------|
| `query_team_resource(ctx, team_id, key)` | `i64, String` | `f64` | Team's resource value. 0 if not found. |
| `query_unit_stat(ctx, character_id, key)` | `i64, String` | `f64` | Character's stat value. 0 if not found. |
| `query_alive_count(ctx, team_id)` | `i64` | `i64` | Number of alive characters on team. |
| `query_phase(ctx)` | — | `String` | Current game phase (e.g., "Exploration"). |
| `query_clock(ctx)` | — | `f64` | Game clock (seconds elapsed). |
| `query_turn(ctx)` | — | `i64` | Current turn number. |

### Example: Simple Rules Script

```rhai
// Gold production + elimination win condition
fn on_event(ctx) {
    let name = ctx.event_name;

    if name == "GameStart" {
        cmd_log(ctx, "Welcome to the battle!");
        // Spawn a marine for each team
        cmd_spawn(ctx, "marine", 0, 5.0, 5.0);
        cmd_spawn(ctx, "marine", 1, 15.0, 15.0);
    }

    if name == "Tick" {
        // Each team produces 1 gold per second
        let dt = event_data(ctx, "dt");
        cmd_modify_resource(ctx, 0, "gold", dt * 1.0);
        cmd_modify_resource(ctx, 1, "gold", dt * 1.0);
    }

    if name == "UnitKilled" {
        let team_0_alive = query_alive_count(ctx, 0);
        let team_1_alive = query_alive_count(ctx, 1);
        if team_0_alive == 0 {
            cmd_end_game(ctx, 1); // Team 1 wins
        }
        if team_1_alive == 0 {
            cmd_end_game(ctx, 0); // Team 0 wins
        }
    }
}
```

---

## Character AI Scripts (Legacy)

Character AI scripts control individual character behavior each frame.
These use the legacy `ScriptContext` / `ScriptCommand` path. Migration to
`CharacterAiContext` is planned (Track D).

### Entry Point

```rhai
fn update(ctx) {
    let enemy = find_nearest(ctx, "enemy");
    if enemy >= 0 {
        let pos = get_position(ctx, enemy);
        let me = self_pos(ctx);
        if dist_vec(me, pos) < 3.0 {
            attack(ctx, enemy);
        } else {
            move_to(ctx, pos.x, pos.y);
        }
    }
}
```

### Command Functions

| Function | Parameters | Description |
|----------|-----------|-------------|
| `move_to(ctx, x, y)` | `f64, f64` | Move toward target position (A* pathfinding). |
| `attack(ctx, target_id)` | `i64` | Attack a target character. |
| `face(ctx, direction)` | `String` | Face "north", "south", "east", or "west". |
| `set_animation(ctx, state)` | `String` | Set animation: "idle", "walk", "melee", "throw". |
| `set_velocity(ctx, vx, vy)` | `f64, f64` | Override movement with direct velocity. |
| `play_sound(ctx, name)` | `String` | Play a named sound (placeholder, not yet wired). |

### Query Functions

| Function | Parameters | Returns | Description |
|----------|-----------|---------|-------------|
| `find_nearest(ctx, tag)` | `String` | `i64` | Actor ID of nearest actor with tag, or -1. |
| `get_position(ctx, actor_id)` | `i64` | `Vec2` | Position of an actor. |
| `self_pos(ctx)` | — | `Vec2` | This character's position. |
| `self_id(ctx)` | — | `i64` | This character's actor ID. |
| `dt(ctx)` | — | `f64` | Delta time (seconds per frame). |

### Utility Functions

Available in all AI scripts (no ctx needed):

| Function | Parameters | Returns | Description |
|----------|-----------|---------|-------------|
| `dist(x1, y1, x2, y2)` | `f64 x4` | `f64` | Euclidean distance between two points. |
| `dist_vec(a, b)` | `Vec2, Vec2` | `f64` | Euclidean distance between two Vec2s. |
| `normalize(x, y)` | `f64, f64` | `Vec2` | Unit vector (0,0 if zero-length). |
| `lerp(a, b, t)` | `f64, f64, f64` | `f64` | Linear interpolation (t clamped to 0..1). |
| `vec2(x, y)` | `f64, f64` | `Vec2` | Create a Vec2. |

### Vec2 Type

| Property | Type | Access |
|----------|------|--------|
| `.x` | `f64` | get/set |
| `.y` | `f64` | get/set |

### Example: Patrol Script

```rhai
// Patrol between two points
fn update(ctx) {
    let me = self_pos(ctx);
    let target_x = 10.0;
    let target_y = 5.0;

    // Simple patrol: walk to target, then walk back
    if dist(me.x, me.y, target_x, target_y) < 0.5 {
        // Arrived — swap target (would need state for real patrol)
        move_to(ctx, 0.0, 0.0);
    } else {
        move_to(ctx, target_x, target_y);
    }
}
```

### Example: Chase Nearest Enemy

```rhai
fn update(ctx) {
    let enemy = find_nearest(ctx, "enemy");
    if enemy < 0 {
        return; // No enemies
    }

    let pos = get_position(ctx, enemy);
    let me = self_pos(ctx);
    let d = dist_vec(me, pos);

    if d < 1.5 {
        attack(ctx, enemy);
    } else if d < 20.0 {
        move_to(ctx, pos.x, pos.y);
    }
    // If enemy is >20 tiles away, ignore
}
```

---

## World Generation Scripts (Future)

World gen scripts run once during `GamePhase::Setup` to populate the map.
Not yet wired to the orchestrator (Track E).

### Entry Point

```rhai
fn generate(ctx) {
    // Place a 10x10 grass field
    for x in range(0, 10) {
        for y in range(0, 10) {
            cmd_place_tile(ctx, x, y, "iarba", 0, 0);
        }
    }
    // Define spawn zones
    cmd_define_zone(ctx, "spawn_a", 0, 0, 5, 5, "spawn", 0);
    cmd_define_zone(ctx, "spawn_b", 15, 15, 5, 5, "spawn", 1);
    // Spawn initial units
    cmd_spawn(ctx, "marine", 0, 2.5, 2.5);
    cmd_spawn(ctx, "zombie", 1, 17.5, 17.5);
}
```

### Command Functions

| Function | Parameters | Description |
|----------|-----------|-------------|
| `cmd_place_tile(ctx, x, y, asset_id, layer, variant)` | `i64, i64, String, i64, i64` | Place a tile at grid coordinates. |
| `cmd_spawn(ctx, template_id, team_id, x, y)` | `String, i64, f64, f64` | Spawn a character. |
| `cmd_define_zone(ctx, name, x, y, w, h, zone_type, team_id)` | `String, i64, i64, i64, i64, String, i64` | Define a named zone. Pass team_id=-1 for no team. |
| `cmd_log(ctx, message)` | `String` | Print to console. |

**Zone types (string values for `zone_type` parameter):**
- `"spawn"` — Spawn point
- `"encounter"` — Encounter trigger area (Tactical mode)
- `"extraction"` — Objective zone
- `"wave_source"` — Enemy spawn for tower defense
- `"resource_producer:key:rate"` — Resource production (e.g., `"resource_producer:gold:10"`)
- `"custom"` — Script-defined purpose

---

## Type Reference

### GameMode
Defined in GameDefinition. Controls time model.
- `RealTime` — Continuous. Tick events every frame.
- `Tactical` — Real-time exploration, auto-pause on encounter.
- `TurnBased` — Discrete turns. TurnStart/TurnEnd events.

### GamePhase
Current state of the game session.
- `Setup` — World gen scripts running.
- `Exploration` — Characters moving freely. Tick events firing.
- `EncounterDecision` — Paused for planning (Tactical mode).
- `EncounterResolution` — Actions playing out.
- `Turn { team }` — One team taking their turn (TurnBased).
- `Ended { winner }` — Game over.

### IDs
- **team_id** (`i64`): Team identifier. Matches `TeamDefinition.id`.
- **character_id** (`i64`): Character instance identifier. Stable across the session.
- **actor_id** (`i64`): Rendering actor ID (legacy AI scripts only). Not stable across save/load.
- **template_id** (`String`): Character template identifier from GameDefinition.

---

## Sandbox Rules

1. Scripts cannot access the filesystem, network, or any system resources.
2. Scripts cannot call functions from other scopes (no `move_to` in rules scripts).
3. Scripts cannot mutate game state directly — only via `cmd_*` functions.
4. All `query_*` functions return snapshots, not live references.
5. Script execution errors are caught and logged. They do not crash the game.
6. Scripts cannot persist state between calls (fresh Scope each execution).

---

## Loading Scripts

Scripts are loaded via the WASM `reload_scripts(json)` export. The JSON format is:

```json
{
  "my_rules": "fn on_event(ctx) { ... }",
  "patrol_ai": "fn update(ctx) { ... }",
  "worldgen": "fn generate(ctx) { ... }"
}
```

All scripts are compiled to AST on load. Compilation errors are logged to the
browser console. Scripts that fail to compile are silently skipped during execution.

Script names are referenced by:
- `GameDefinition.rules_script` — which script handles game events
- `GameDefinition.world_gen_script` — which script generates the world
- `CharacterInstance.ai_script` — which script controls a character
- `TeamDefinition.controller.Cpu.script_name` — team-level AI

---

## Implementation Status

| Feature | Status |
|---------|--------|
| Rules script execution (on_event) | Working — orchestrator runs per event |
| Rules commands (all 8) | Working — applied by orchestrator |
| Rules queries (all 6) | Working — read from GameView snapshot |
| Event DTO (numeric + string channels) | Working — no data loss at boundary |
| Character AI execution (update) | Working — legacy path via ScriptContext |
| World gen execution (generate) | Not yet wired — Track E |
| Script hot-reload | Working — reload_scripts() WASM export |
| Script persistence in IDB | Not yet implemented — Track C |
