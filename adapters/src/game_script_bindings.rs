//! Rhai script bindings for the game rules system — three isolated scopes.
//!
//! Each scope has its own context type with a restricted API:
//!
//! 1. **CharacterAiContext** — per-character behavior each frame.
//!    Can: move, attack, query nearby units, read own stats.
//!    Cannot: modify game state, spawn units, change resources.
//!
//! 2. **RulesContext** — game-level logic, event handling.
//!    Can: modify resources, spawn/despawn units, change phase, emit events,
//!         read/write any character stats, define damage formulas.
//!    Cannot: directly move characters (issues commands instead).
//!
//! 3. **WorldGenContext** — setup-time world generation.
//!    Can: place tiles, spawn characters at positions, set up zones.
//!    Cannot: modify game state, handle events, interact with combat.
//!
//! All contexts receive data as DTOs — no direct access to core entities.
//! Commands are collected and applied by the WASM orchestrator after script execution.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use glam::Vec2;
use zapsquad_core::entities::ActorId;
use zapsquad_core::entities::game_rules::{
    TeamId, CharacterInstanceId, GamePhase, GameMode,
};

// ── Commands emitted by scripts ─────────────────────────────────────────────

/// Commands from character AI scripts.
#[derive(Debug, Clone)]
pub enum AiCommand {
    MoveTo(Vec2),
    Attack(CharacterInstanceId),
    Face(String),
    SetAnimation(String),
    SetVelocity(Vec2),
    PlaySound(String),
}

/// Commands from rules scripts.
#[derive(Debug, Clone)]
pub enum RulesCommand {
    /// Spawn a character from template at position, assigned to team.
    SpawnUnit {
        template_id: String,
        team_id: u32,
        x: f32,
        y: f32,
        individual: bool,
    },
    /// Kill a character.
    KillUnit { character_id: u32 },
    /// Modify a character's stat.
    ModifyStat {
        character_id: u32,
        stat_key: String,
        delta: f32,
    },
    /// Set a character's stat to an exact value.
    SetStat {
        character_id: u32,
        stat_key: String,
        value: f32,
    },
    /// Modify a team's resource.
    ModifyResource {
        team_id: u32,
        resource_key: String,
        delta: f32,
    },
    /// Transition game phase.
    SetPhase(String),
    /// End the game with a winner.
    EndGame { winner_team_id: Option<u32> },
    /// Emit a custom event.
    EmitEvent {
        name: String,
        data: HashMap<String, f32>,
    },
    /// Log a message to the console (for debugging scripts).
    Log(String),
}

/// Commands from world generation scripts.
#[derive(Debug, Clone)]
pub enum WorldGenCommand {
    /// Place a tile at coordinates.
    PlaceTile {
        x: i32,
        y: i32,
        asset_id: String,
        layer: u8,
        variant: u8,
    },
    /// Spawn a character at position.
    SpawnUnit {
        template_id: String,
        team_id: u32,
        x: f32,
        y: f32,
    },
    /// Define a named zone with type and optional team assignment.
    /// zone_type values: "spawn", "encounter", "extraction", "wave_source",
    ///   "resource_producer:key:rate" (e.g., "resource_producer:gold:10"), "custom"
    DefineZone {
        name: String,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        zone_type: String,
        team_id: Option<u32>,
    },
    /// Log a message.
    Log(String),
}

// ── Read-only query data passed to scripts ──────────────────────────────────

/// Snapshot of a character's visible state, passed to AI scripts.
#[derive(Debug, Clone)]
pub struct CharacterView {
    pub instance_id: u32,
    pub team_id: u32,
    pub x: f32,
    pub y: f32,
    pub stats: HashMap<String, f32>,
    pub alive: bool,
    pub tags: Vec<String>,
}

/// Snapshot of team state, passed to rules scripts.
#[derive(Debug, Clone)]
pub struct TeamView {
    pub id: u32,
    pub name: String,
    pub resources: HashMap<String, f32>,
    pub eliminated: bool,
    pub unit_count: usize,
}

/// Read-only game state snapshot passed to scripts.
#[derive(Debug, Clone)]
pub struct GameView {
    pub mode: String,
    pub phase: String,
    pub clock: f32,
    pub turn_number: u32,
    pub active_team_id: Option<u32>,
    pub teams: Vec<TeamView>,
    pub characters: Vec<CharacterView>,
}

// ── Script Contexts ─────────────────────────────────────────────────────────

/// Context for character AI scripts. Read-only game state + command output.
#[derive(Clone)]
pub struct CharacterAiContext {
    pub self_id: u32,
    pub self_team: u32,
    pub self_pos: Vec2,
    pub self_stats: HashMap<String, f32>,
    pub dt: f32,
    pub game: GameView,
    commands: Arc<Mutex<Vec<AiCommand>>>,
}

impl CharacterAiContext {
    pub fn new(
        self_id: u32,
        self_team: u32,
        self_pos: Vec2,
        self_stats: HashMap<String, f32>,
        dt: f32,
        game: GameView,
    ) -> Self {
        Self {
            self_id,
            self_team,
            self_pos,
            self_stats,
            dt,
            game,
            commands: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn take_commands(&self) -> Vec<AiCommand> {
        std::mem::take(&mut self.commands.lock().unwrap())
    }

    // -- Command methods exposed to Rhai --

    pub fn cmd_move_to(&self, x: f64, y: f64) {
        self.commands.lock().unwrap().push(AiCommand::MoveTo(Vec2::new(x as f32, y as f32)));
    }

    pub fn cmd_attack(&self, target_id: i64) {
        self.commands.lock().unwrap().push(AiCommand::Attack(CharacterInstanceId(target_id as u32)));
    }

    pub fn cmd_face(&self, direction: String) {
        self.commands.lock().unwrap().push(AiCommand::Face(direction));
    }

    pub fn cmd_set_animation(&self, state: String) {
        self.commands.lock().unwrap().push(AiCommand::SetAnimation(state));
    }

    pub fn cmd_set_velocity(&self, x: f64, y: f64) {
        self.commands.lock().unwrap().push(AiCommand::SetVelocity(Vec2::new(x as f32, y as f32)));
    }

    pub fn cmd_play_sound(&self, name: String) {
        self.commands.lock().unwrap().push(AiCommand::PlaySound(name));
    }

    // -- Query methods exposed to Rhai --

    pub fn query_self_id(&self) -> i64 { self.self_id as i64 }
    pub fn query_self_team(&self) -> i64 { self.self_team as i64 }
    pub fn query_self_x(&self) -> f64 { self.self_pos.x as f64 }
    pub fn query_self_y(&self) -> f64 { self.self_pos.y as f64 }
    pub fn query_self_pos(&self) -> Vec2 { self.self_pos }
    pub fn query_dt(&self) -> f64 { self.dt as f64 }

    pub fn query_self_stat(&self, key: String) -> f64 {
        self.self_stats.get(&key).copied().unwrap_or(0.0) as f64
    }

    /// Find nearest character matching a selector. Returns instance_id or -1.
    /// Excludes self. Excludes dead characters.
    ///
    /// **Reserved relation keywords** (resolved from `self_team`, not from tags):
    /// - `"enemy"` → matches characters on a different team
    /// - `"ally"`  → matches characters on the same team (excluding self)
    ///
    /// These keywords take precedence over `CharacterView.tags`. A character
    /// with a literal tag `"enemy"` on a same-team unit will NOT be found
    /// by `find_nearest(ctx, "enemy")` — the computed relation wins.
    /// This is a documented constraint. Do not use `"enemy"` or `"ally"`
    /// as custom tag strings.
    ///
    /// All other selector strings fall through to `CharacterView.tags` matching.
    /// This keeps the global `GameView` DTO free of viewer-relative data
    /// while preserving the legacy `find_nearest(ctx, "enemy")` contract.
    pub fn query_find_nearest(&self, tag: &str) -> i64 {
        let mut best_id: i64 = -1;
        let mut best_dist = f64::MAX;
        for c in &self.game.characters {
            if c.instance_id == self.self_id { continue; }
            if !c.alive { continue; }

            let matches = match tag {
                "enemy" => c.team_id != self.self_team,
                "ally"  => c.team_id == self.self_team,
                _       => c.tags.iter().any(|t| t == tag),
            };
            if !matches { continue; }

            let dx = c.x as f64 - self.self_pos.x as f64;
            let dy = c.y as f64 - self.self_pos.y as f64;
            let dist = dx * dx + dy * dy;
            if dist < best_dist {
                best_dist = dist;
                best_id = c.instance_id as i64;
            }
        }
        best_id
    }

    /// Find nearest enemy (different team, alive). Convenience for the common case.
    pub fn query_find_nearest_enemy(&self) -> i64 {
        let mut best_id: i64 = -1;
        let mut best_dist = f64::MAX;
        for c in &self.game.characters {
            if c.instance_id == self.self_id { continue; }
            if c.team_id == self.self_team || !c.alive { continue; }
            let dx = c.x as f64 - self.self_pos.x as f64;
            let dy = c.y as f64 - self.self_pos.y as f64;
            let dist = dx * dx + dy * dy;
            if dist < best_dist {
                best_dist = dist;
                best_id = c.instance_id as i64;
            }
        }
        best_id
    }

    /// Get position of a character by instance_id. Returns Some(Vec2) or None.
    pub fn query_get_position(&self, id: i64) -> Option<Vec2> {
        for c in &self.game.characters {
            if c.instance_id == id as u32 {
                return Some(Vec2::new(c.x, c.y));
            }
        }
        None
    }
}

/// Context for rules scripts. Full game state mutation.
#[derive(Clone)]
pub struct RulesContext {
    pub game: GameView,
    pub event_name: String,
    /// Numeric event parameters (e.g., dt, damage, team_id, old_value, new_value).
    pub event_data: HashMap<String, f64>,
    /// String event parameters (e.g., stat_key, resource_key, zone_id, custom event name).
    /// Avoids encoding strings into event_name or losing typed data at the DTO boundary.
    pub event_strings: HashMap<String, String>,
    commands: Arc<Mutex<Vec<RulesCommand>>>,
}

impl RulesContext {
    pub fn new(
        game: GameView,
        event_name: String,
        event_data: HashMap<String, f64>,
        event_strings: HashMap<String, String>,
    ) -> Self {
        Self {
            game,
            event_name,
            event_data,
            event_strings,
            commands: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn take_commands(&self) -> Vec<RulesCommand> {
        std::mem::take(&mut self.commands.lock().unwrap())
    }

    // -- Command methods --

    pub fn cmd_spawn(&self, template_id: String, team_id: i64, x: f64, y: f64) {
        self.commands.lock().unwrap().push(RulesCommand::SpawnUnit {
            template_id,
            team_id: team_id as u32,
            x: x as f32,
            y: y as f32,
            individual: false,
        });
    }

    pub fn cmd_spawn_individual(&self, template_id: String, team_id: i64, x: f64, y: f64) {
        self.commands.lock().unwrap().push(RulesCommand::SpawnUnit {
            template_id,
            team_id: team_id as u32,
            x: x as f32,
            y: y as f32,
            individual: true,
        });
    }

    pub fn cmd_kill(&self, character_id: i64) {
        self.commands.lock().unwrap().push(RulesCommand::KillUnit {
            character_id: character_id as u32,
        });
    }

    pub fn cmd_modify_stat(&self, character_id: i64, stat_key: String, delta: f64) {
        self.commands.lock().unwrap().push(RulesCommand::ModifyStat {
            character_id: character_id as u32,
            stat_key,
            delta: delta as f32,
        });
    }

    pub fn cmd_set_stat(&self, character_id: i64, stat_key: String, value: f64) {
        self.commands.lock().unwrap().push(RulesCommand::SetStat {
            character_id: character_id as u32,
            stat_key,
            value: value as f32,
        });
    }

    pub fn cmd_modify_resource(&self, team_id: i64, resource_key: String, delta: f64) {
        self.commands.lock().unwrap().push(RulesCommand::ModifyResource {
            team_id: team_id as u32,
            resource_key,
            delta: delta as f32,
        });
    }

    pub fn cmd_end_game(&self, winner_team_id: i64) {
        self.commands.lock().unwrap().push(RulesCommand::EndGame {
            winner_team_id: if winner_team_id < 0 { None } else { Some(winner_team_id as u32) },
        });
    }

    pub fn cmd_log(&self, msg: String) {
        self.commands.lock().unwrap().push(RulesCommand::Log(msg));
    }

    // -- Query methods --

    pub fn query_team_resource(&self, team_id: i64, key: String) -> f64 {
        for t in &self.game.teams {
            if t.id == team_id as u32 {
                return t.resources.get(&key).copied().unwrap_or(0.0) as f64;
            }
        }
        0.0
    }

    pub fn query_unit_stat(&self, character_id: i64, key: String) -> f64 {
        for c in &self.game.characters {
            if c.instance_id == character_id as u32 {
                return c.stats.get(&key).copied().unwrap_or(0.0) as f64;
            }
        }
        0.0
    }

    pub fn query_alive_count(&self, team_id: i64) -> i64 {
        self.game.characters.iter()
            .filter(|c| c.team_id == team_id as u32 && c.alive)
            .count() as i64
    }

    pub fn query_phase(&self) -> String { self.game.phase.clone() }
    pub fn query_clock(&self) -> f64 { self.game.clock as f64 }
    pub fn query_turn(&self) -> i64 { self.game.turn_number as i64 }
}

/// Context for world generation scripts. World mutation only.
#[derive(Clone)]
pub struct WorldGenContext {
    commands: Arc<Mutex<Vec<WorldGenCommand>>>,
}

impl WorldGenContext {
    pub fn new() -> Self {
        Self {
            commands: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn take_commands(&self) -> Vec<WorldGenCommand> {
        std::mem::take(&mut self.commands.lock().unwrap())
    }

    pub fn cmd_place_tile(&self, x: i64, y: i64, asset_id: String, layer: i64, variant: i64) {
        self.commands.lock().unwrap().push(WorldGenCommand::PlaceTile {
            x: x as i32,
            y: y as i32,
            asset_id,
            layer: layer as u8,
            variant: variant as u8,
        });
    }

    pub fn cmd_spawn(&self, template_id: String, team_id: i64, x: f64, y: f64) {
        self.commands.lock().unwrap().push(WorldGenCommand::SpawnUnit {
            template_id,
            team_id: team_id as u32,
            x: x as f32,
            y: y as f32,
        });
    }

    pub fn cmd_define_zone(&self, name: String, x: i64, y: i64, width: i64, height: i64, zone_type: String, team_id: i64) {
        self.commands.lock().unwrap().push(WorldGenCommand::DefineZone {
            name,
            x: x as i32,
            y: y as i32,
            width: width as i32,
            height: height as i32,
            zone_type,
            team_id: if team_id < 0 { None } else { Some(team_id as u32) },
        });
    }

    pub fn cmd_log(&self, msg: String) {
        self.commands.lock().unwrap().push(WorldGenCommand::Log(msg));
    }
}

// ── Rules Script Engine ─────────────────────────────────────────────────────
//
// Separate Rhai Engine instance for rules scripts. Registers only the
// RulesContext type and its methods — no AI or WorldGen types leak in.
// Compile + AST cache follows the same pattern as ScriptEngine.

use rhai::{Engine, Scope, AST, EvalAltResult};

/// Rhai engine for rules scripts. Isolated from AI and WorldGen scopes.
///
/// Rules scripts define an `on_event(ctx)` function. The orchestrator calls
/// it once per event with a `RulesContext` containing the game state snapshot
/// and event metadata. The script emits commands via `cmd_*` methods.
pub struct RulesScriptEngine {
    engine: Engine,
    scripts: HashMap<String, AST>,
}

impl RulesScriptEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // ── Register RulesContext type ───────────────────────────────
        engine.register_type_with_name::<RulesContext>("RulesCtx");

        // ── Event metadata accessors ────────────────────────────────
        engine.register_get("event_name", |ctx: &mut RulesContext| ctx.event_name.clone());
        engine.register_fn("event_data", |ctx: &mut RulesContext, key: String| -> f64 {
            ctx.event_data.get(&key).copied().unwrap_or(0.0)
        });
        engine.register_fn("event_string", |ctx: &mut RulesContext, key: String| -> String {
            ctx.event_strings.get(&key).cloned().unwrap_or_default()
        });

        // ── Command methods ─────────────────────────────────────────
        engine.register_fn("cmd_spawn", |ctx: &mut RulesContext, template_id: String, team_id: i64, x: f64, y: f64| {
            ctx.cmd_spawn(template_id, team_id, x, y);
        });
        engine.register_fn("cmd_spawn_individual", |ctx: &mut RulesContext, template_id: String, team_id: i64, x: f64, y: f64| {
            ctx.cmd_spawn_individual(template_id, team_id, x, y);
        });
        engine.register_fn("cmd_kill", |ctx: &mut RulesContext, character_id: i64| {
            ctx.cmd_kill(character_id);
        });
        engine.register_fn("cmd_modify_stat", |ctx: &mut RulesContext, character_id: i64, stat_key: String, delta: f64| {
            ctx.cmd_modify_stat(character_id, stat_key, delta);
        });
        engine.register_fn("cmd_set_stat", |ctx: &mut RulesContext, character_id: i64, stat_key: String, value: f64| {
            ctx.cmd_set_stat(character_id, stat_key, value);
        });
        engine.register_fn("cmd_modify_resource", |ctx: &mut RulesContext, team_id: i64, resource_key: String, delta: f64| {
            ctx.cmd_modify_resource(team_id, resource_key, delta);
        });
        engine.register_fn("cmd_end_game", |ctx: &mut RulesContext, winner_team_id: i64| {
            ctx.cmd_end_game(winner_team_id);
        });
        engine.register_fn("cmd_log", |ctx: &mut RulesContext, msg: String| {
            ctx.cmd_log(msg);
        });

        // ── Query methods ───────────────────────────────────────────
        engine.register_fn("query_team_resource", |ctx: &mut RulesContext, team_id: i64, key: String| -> f64 {
            ctx.query_team_resource(team_id, key)
        });
        engine.register_fn("query_unit_stat", |ctx: &mut RulesContext, character_id: i64, key: String| -> f64 {
            ctx.query_unit_stat(character_id, key)
        });
        engine.register_fn("query_alive_count", |ctx: &mut RulesContext, team_id: i64| -> i64 {
            ctx.query_alive_count(team_id)
        });
        engine.register_fn("query_phase", |ctx: &mut RulesContext| -> String {
            ctx.query_phase()
        });
        engine.register_fn("query_clock", |ctx: &mut RulesContext| -> f64 {
            ctx.query_clock()
        });
        engine.register_fn("query_turn", |ctx: &mut RulesContext| -> i64 {
            ctx.query_turn()
        });

        Self { engine, scripts: HashMap::new() }
    }

    /// Compile a rules script and cache the AST.
    pub fn compile_script(&mut self, name: &str, source: &str) -> Result<(), Box<EvalAltResult>> {
        let ast = self.engine.compile(source)?;
        self.scripts.insert(name.to_string(), ast);
        Ok(())
    }

    /// Check if a named script exists.
    pub fn has_script(&self, name: &str) -> bool {
        self.scripts.contains_key(name)
    }

    /// Remove a compiled script.
    pub fn remove_script(&mut self, name: &str) {
        self.scripts.remove(name);
    }

    /// Remove all compiled scripts.
    pub fn clear_scripts(&mut self) {
        self.scripts.clear();
    }

    /// List all compiled script names.
    pub fn list_scripts(&self) -> Vec<&str> {
        self.scripts.keys().map(|s| s.as_str()).collect()
    }

    /// Execute a rules script's `on_event(ctx)` function.
    ///
    /// Returns the commands emitted by the script, or an error if
    /// the script is not found or execution fails.
    pub fn run_on_event(
        &self,
        script_name: &str,
        ctx: RulesContext,
    ) -> Result<Vec<RulesCommand>, Box<EvalAltResult>> {
        let ast = self.scripts.get(script_name)
            .ok_or_else(|| -> Box<EvalAltResult> {
                format!("Rules script '{}' not found", script_name).into()
            })?;
        let mut scope = Scope::new();
        let _: () = self.engine.call_fn(&mut scope, ast, "on_event", (ctx.clone(),))?;
        Ok(ctx.take_commands())
    }
}

/// Rhai engine for character AI scripts. Isolated from Rules and WorldGen scopes.
///
/// AI scripts define an `update(ctx)` function. The orchestrator calls it once
/// per frame for each character that has a script assigned. The script receives
/// a `CharacterAiContext` with the character's own state and a read-only game
/// snapshot, and emits movement/combat commands via `cmd_*` methods.
///
/// The Rhai-facing API uses the legacy function names (`move_to`, `attack`,
/// `find_nearest`, `self_pos`, etc.) so that existing saved scripts and shipped
/// examples remain compatible. The Rust-side method names (`cmd_move_to`,
/// `query_find_nearest`) are internal and not exposed to script authors.
pub struct AiScriptEngine {
    engine: Engine,
    scripts: HashMap<String, AST>,
}

impl AiScriptEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // ── Vec2 type (legacy scripts use .x / .y on positions) ──────
        engine
            .register_type_with_name::<Vec2>("Vec2")
            .register_fn("vec2", |x: f64, y: f64| Vec2::new(x as f32, y as f32))
            .register_get("x", |v: &mut Vec2| v.x as f64)
            .register_get("y", |v: &mut Vec2| v.y as f64)
            .register_set("x", |v: &mut Vec2, x: f64| v.x = x as f32)
            .register_set("y", |v: &mut Vec2, y: f64| v.y = y as f32);

        // ── Register CharacterAiContext type ──────────────────────────
        engine.register_type_with_name::<CharacterAiContext>("Context");

        // ── Command functions (legacy names) ─────────────────────────
        engine.register_fn("move_to", |ctx: &mut CharacterAiContext, x: f64, y: f64| {
            ctx.cmd_move_to(x, y);
        });
        engine.register_fn("attack", |ctx: &mut CharacterAiContext, target_id: i64| {
            ctx.cmd_attack(target_id);
        });
        engine.register_fn("face", |ctx: &mut CharacterAiContext, direction: String| {
            ctx.cmd_face(direction);
        });
        engine.register_fn("set_animation", |ctx: &mut CharacterAiContext, state: String| {
            ctx.cmd_set_animation(state);
        });
        engine.register_fn("set_velocity", |ctx: &mut CharacterAiContext, x: f64, y: f64| {
            ctx.cmd_set_velocity(x, y);
        });
        engine.register_fn("play_sound", |ctx: &mut CharacterAiContext, name: String| {
            ctx.cmd_play_sound(name);
        });

        // ── Query functions (legacy names) ───────────────────────────

        // find_nearest(ctx, tag) — tag-based search (legacy contract).
        // The orchestrator must populate CharacterView.tags (e.g., "enemy")
        // for this to match. Returns instance_id or -1.
        engine.register_fn("find_nearest", |ctx: &mut CharacterAiContext, tag: String| -> i64 {
            ctx.query_find_nearest(&tag)
        });

        // get_position(ctx, id) — returns Vec2 (with .x, .y) or unit.
        engine.register_fn("get_position", |ctx: &mut CharacterAiContext, id: i64| -> rhai::Dynamic {
            match ctx.query_get_position(id) {
                Some(pos) => rhai::Dynamic::from(pos),
                None => rhai::Dynamic::UNIT,
            }
        });

        // self_pos(ctx) — returns Vec2
        engine.register_fn("self_pos", |ctx: &mut CharacterAiContext| -> Vec2 {
            ctx.query_self_pos()
        });

        // self_id(ctx) — returns i64
        engine.register_fn("self_id", |ctx: &mut CharacterAiContext| -> i64 {
            ctx.query_self_id()
        });

        // dt(ctx) — delta time as f64
        engine.register_fn("dt", |ctx: &mut CharacterAiContext| -> f64 {
            ctx.query_dt()
        });

        // ── Extended queries (new API, no legacy equivalent) ─────────
        engine.register_fn("self_team", |ctx: &mut CharacterAiContext| -> i64 {
            ctx.query_self_team()
        });
        engine.register_fn("self_stat", |ctx: &mut CharacterAiContext, key: String| -> f64 {
            ctx.query_self_stat(key)
        });
        engine.register_fn("find_nearest_enemy", |ctx: &mut CharacterAiContext| -> i64 {
            ctx.query_find_nearest_enemy()
        });

        // ── Utility functions (standalone, no context) ───────────────
        engine.register_fn("dist", |x1: f64, y1: f64, x2: f64, y2: f64| -> f64 {
            let dx = x2 - x1;
            let dy = y2 - y1;
            (dx * dx + dy * dy).sqrt()
        });
        engine.register_fn("dist_vec", |a: Vec2, b: Vec2| -> f64 {
            a.distance(b) as f64
        });
        engine.register_fn("normalize", |x: f64, y: f64| -> Vec2 {
            let v = Vec2::new(x as f32, y as f32);
            if v.length_squared() > 0.0001 { v.normalize() } else { Vec2::ZERO }
        });
        engine.register_fn("lerp", |a: f64, b: f64, t: f64| -> f64 {
            a + (b - a) * t.clamp(0.0, 1.0)
        });

        Self { engine, scripts: HashMap::new() }
    }

    /// Compile an AI script and cache the AST.
    pub fn compile_script(&mut self, name: &str, source: &str) -> Result<(), Box<EvalAltResult>> {
        let ast = self.engine.compile(source)?;
        self.scripts.insert(name.to_string(), ast);
        Ok(())
    }

    /// Check if a named script exists.
    pub fn has_script(&self, name: &str) -> bool {
        self.scripts.contains_key(name)
    }

    /// Remove a compiled script.
    pub fn remove_script(&mut self, name: &str) {
        self.scripts.remove(name);
    }

    /// Remove all compiled scripts.
    pub fn clear_scripts(&mut self) {
        self.scripts.clear();
    }

    /// List all compiled script names.
    pub fn list_scripts(&self) -> Vec<&str> {
        self.scripts.keys().map(|s| s.as_str()).collect()
    }

    /// Execute an AI script's `update(ctx)` function.
    ///
    /// Returns the commands emitted by the script, or an error if
    /// the script is not found or execution fails.
    pub fn run_update(
        &self,
        script_name: &str,
        ctx: CharacterAiContext,
    ) -> Result<Vec<AiCommand>, Box<EvalAltResult>> {
        let ast = self.scripts.get(script_name)
            .ok_or_else(|| -> Box<EvalAltResult> {
                format!("AI script '{}' not found", script_name).into()
            })?;
        let mut scope = Scope::new();
        let _: () = self.engine.call_fn(&mut scope, ast, "update", (ctx.clone(),))?;
        Ok(ctx.take_commands())
    }
}

/// Rhai engine for world generation scripts. Isolated from AI and Rules scopes.
///
/// World gen scripts define a `generate(ctx)` function. The orchestrator calls it
/// once during `GamePhase::Setup` (when Play is pressed). The script receives a
/// `WorldGenContext` and emits tile placement, unit spawning, and zone definition
/// commands.
pub struct WorldGenScriptEngine {
    engine: Engine,
    scripts: HashMap<String, AST>,
    /// Shared RNG state for `rand()` / `seed()`. Reset to default before each run.
    rng_state: Arc<Mutex<u32>>,
}

impl WorldGenScriptEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();

        engine.register_type_with_name::<WorldGenContext>("WorldGenCtx");

        // ── Command functions ────────────────────────────────────────
        engine.register_fn("place_tile", |ctx: &mut WorldGenContext, x: i64, y: i64, asset_id: String, layer: i64, variant: i64| {
            ctx.cmd_place_tile(x, y, asset_id, layer, variant);
        });
        engine.register_fn("spawn_unit", |ctx: &mut WorldGenContext, template_id: String, team_id: i64, x: f64, y: f64| {
            ctx.cmd_spawn(template_id, team_id, x, y);
        });
        engine.register_fn("define_zone", |ctx: &mut WorldGenContext, name: String, x: i64, y: i64, width: i64, height: i64, zone_type: String, team_id: i64| {
            ctx.cmd_define_zone(name, x, y, width, height, zone_type, team_id);
        });
        engine.register_fn("log", |ctx: &mut WorldGenContext, msg: String| {
            ctx.cmd_log(msg);
        });

        // ── Utility: random number generation for procedural layouts ─
        // Uses xorshift32 — identical on WASM and off-target so tests
        // verify the same code path as production.  Seeded with a fixed
        // value per engine instance; scripts call `seed(n)` to set it.
        let rng_state = Arc::new(Mutex::new(42u32));

        let rng_seed = Arc::clone(&rng_state);
        engine.register_fn("seed", move |s: i64| {
            *rng_seed.lock().unwrap() = if s == 0 { 1 } else { s as u32 };
        });

        let rng_rand = Arc::clone(&rng_state);
        engine.register_fn("rand", move |min: i64, max: i64| -> i64 {
            if min >= max { return min; }
            let mut state = rng_rand.lock().unwrap();
            // xorshift32
            let mut s = *state;
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            *state = s;
            let range = (max - min + 1) as u32;
            min + (s % range) as i64
        });

        Self { engine, scripts: HashMap::new(), rng_state }
    }

    /// Reset the RNG to the default seed. Called before each `run_generate`
    /// so that repeated Play runs produce the same layout when scripts do
    /// not explicitly call `seed(...)`.
    const DEFAULT_SEED: u32 = 42;

    pub fn compile_script(&mut self, name: &str, source: &str) -> Result<(), Box<EvalAltResult>> {
        let ast = self.engine.compile(source)?;
        self.scripts.insert(name.to_string(), ast);
        Ok(())
    }

    pub fn has_script(&self, name: &str) -> bool {
        self.scripts.contains_key(name)
    }

    pub fn remove_script(&mut self, name: &str) {
        self.scripts.remove(name);
    }

    pub fn clear_scripts(&mut self) {
        self.scripts.clear();
    }

    pub fn list_scripts(&self) -> Vec<&str> {
        self.scripts.keys().map(|s| s.as_str()).collect()
    }

    /// Execute a world gen script's `generate(ctx)` function.
    /// Resets the RNG seed to the default before each run so repeated
    /// Play presses produce identical layouts unless the script calls `seed()`.
    pub fn run_generate(
        &self,
        script_name: &str,
        ctx: WorldGenContext,
    ) -> Result<Vec<WorldGenCommand>, Box<EvalAltResult>> {
        // Reset RNG to default seed for deterministic replay
        *self.rng_state.lock().unwrap() = Self::DEFAULT_SEED;

        let ast = self.scripts.get(script_name)
            .ok_or_else(|| -> Box<EvalAltResult> {
                format!("World gen script '{}' not found", script_name).into()
            })?;
        let mut scope = Scope::new();
        let _: () = self.engine.call_fn(&mut scope, ast, "generate", (ctx.clone(),))?;
        Ok(ctx.take_commands())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_game_view() -> GameView {
        GameView {
            mode: "Tactical".into(),
            phase: "Exploration".into(),
            clock: 10.0,
            turn_number: 0,
            active_team_id: None,
            teams: vec![
                TeamView { id: 0, name: "Humans".into(), resources: HashMap::new(), eliminated: false, unit_count: 1 },
                TeamView { id: 1, name: "Aliens".into(), resources: HashMap::new(), eliminated: false, unit_count: 1 },
            ],
            characters: vec![
                CharacterView { instance_id: 1, team_id: 0, x: 5.0, y: 5.0, stats: HashMap::new(), alive: true, tags: vec![] },
                CharacterView { instance_id: 2, team_id: 1, x: 10.0, y: 5.0, stats: HashMap::new(), alive: true, tags: vec![] },
            ],
        }
    }

    #[test]
    fn ai_context_commands() {
        let game = make_game_view();
        let ctx = CharacterAiContext::new(1, 0, Vec2::new(5.0, 5.0), HashMap::new(), 1.0 / 60.0, game);
        ctx.cmd_move_to(10.0, 5.0);
        ctx.cmd_attack(2);
        let cmds = ctx.take_commands();
        assert_eq!(cmds.len(), 2);
    }

    #[test]
    fn ai_find_nearest_enemy() {
        let game = make_game_view();
        let ctx = CharacterAiContext::new(1, 0, Vec2::new(5.0, 5.0), HashMap::new(), 1.0 / 60.0, game);
        let enemy = ctx.query_find_nearest_enemy();
        assert_eq!(enemy, 2); // the alien at (10, 5)
    }

    #[test]
    fn ai_find_nearest_computed_relations() {
        // "enemy" and "ally" are computed from self_team vs target.team_id.
        // Custom tags fall through to CharacterView.tags matching.
        let game = GameView {
            mode: "Tactical".into(), phase: "Exploration".into(),
            clock: 0.0, turn_number: 0, active_team_id: None,
            teams: vec![],
            characters: vec![
                // Self (team 0, will be excluded)
                CharacterView { instance_id: 1, team_id: 0, x: 0.0, y: 0.0,
                    stats: HashMap::new(), alive: true, tags: vec![] },
                // Ally (same team)
                CharacterView { instance_id: 2, team_id: 0, x: 3.0, y: 0.0,
                    stats: HashMap::new(), alive: true, tags: vec![] },
                // Enemy (different team, closer)
                CharacterView { instance_id: 3, team_id: 1, x: 5.0, y: 0.0,
                    stats: HashMap::new(), alive: true, tags: vec!["healer".into()] },
                // Enemy (different team, farther)
                CharacterView { instance_id: 4, team_id: 1, x: 20.0, y: 0.0,
                    stats: HashMap::new(), alive: true, tags: vec!["healer".into()] },
                // Dead enemy (should be excluded)
                CharacterView { instance_id: 5, team_id: 1, x: 1.0, y: 0.0,
                    stats: HashMap::new(), alive: false, tags: vec![] },
            ],
        };

        let ctx = CharacterAiContext::new(1, 0, Vec2::ZERO, HashMap::new(), 1.0 / 60.0, game);

        // "enemy" → computed: different team, alive → 3 (closer than 4)
        assert_eq!(ctx.query_find_nearest("enemy"), 3);
        // "ally" → computed: same team, alive, not self → 2
        assert_eq!(ctx.query_find_nearest("ally"), 2);
        // "healer" → custom tag on CharacterView.tags → 3 (closer than 4)
        assert_eq!(ctx.query_find_nearest("healer"), 3);
        // "nonexistent" → no match → -1
        assert_eq!(ctx.query_find_nearest("nonexistent"), -1);
    }

    #[test]
    fn rules_context_commands() {
        let game = make_game_view();
        let ctx = RulesContext::new(game, "on_game_start".into(), HashMap::new(), HashMap::new());
        ctx.cmd_spawn("marine".into(), 0, 5.0, 5.0);
        ctx.cmd_modify_resource(0, "gold".into(), 100.0);
        ctx.cmd_end_game(-1);
        let cmds = ctx.take_commands();
        assert_eq!(cmds.len(), 3);
    }

    #[test]
    fn worldgen_context_commands() {
        let ctx = WorldGenContext::new();
        ctx.cmd_place_tile(5, 5, "iarba".into(), 0, 0);
        ctx.cmd_spawn("marine".into(), 0, 5.5, 5.5);
        ctx.cmd_define_zone("spawn_a".into(), 0, 0, 5, 5, "spawn".into(), 0);
        ctx.cmd_define_zone("enemy_area".into(), 10, 10, 8, 8, "encounter".into(), -1);
        let cmds = ctx.take_commands();
        assert_eq!(cmds.len(), 4);
        // Verify team_id mapping: 0 → Some(0), -1 → None
        if let WorldGenCommand::DefineZone { team_id, .. } = &cmds[2] {
            assert_eq!(*team_id, Some(0));
        }
        if let WorldGenCommand::DefineZone { team_id, zone_type, .. } = &cmds[3] {
            assert_eq!(*team_id, None);
            assert_eq!(zone_type, "encounter");
        }
    }

    #[test]
    fn rules_engine_compile_and_run() {
        let mut engine = RulesScriptEngine::new();
        let source = r#"
            fn on_event(ctx) {
                let name = ctx.event_name;
                if name == "GameStart" {
                    cmd_log(ctx, "Game started!");
                    cmd_spawn(ctx, "marine", 0, 5.0, 5.0);
                }
            }
        "#;
        engine.compile_script("test_rules", source).expect("compile failed");
        assert!(engine.has_script("test_rules"));

        let game = make_game_view();
        let ctx = RulesContext::new(game, "GameStart".into(), HashMap::new(), HashMap::new());
        let cmds = engine.run_on_event("test_rules", ctx).expect("run failed");
        assert_eq!(cmds.len(), 2);
        assert!(matches!(&cmds[0], RulesCommand::Log(msg) if msg == "Game started!"));
        assert!(matches!(&cmds[1], RulesCommand::SpawnUnit { template_id, .. } if template_id == "marine"));
    }

    #[test]
    fn rules_engine_query_methods() {
        let mut engine = RulesScriptEngine::new();
        let source = r#"
            fn on_event(ctx) {
                let alive = query_alive_count(ctx, 0);
                let phase = query_phase(ctx);
                let clock = query_clock(ctx);
                cmd_log(ctx, `alive=${alive} phase=${phase} clock=${clock}`);
            }
        "#;
        engine.compile_script("query_test", source).expect("compile failed");

        let game = make_game_view();
        let ctx = RulesContext::new(game, "Tick".into(), HashMap::new(), HashMap::new());
        let cmds = engine.run_on_event("query_test", ctx).expect("run failed");
        assert_eq!(cmds.len(), 1);
        if let RulesCommand::Log(msg) = &cmds[0] {
            assert!(msg.contains("alive=1"));
            assert!(msg.contains("phase=Exploration"));
            assert!(msg.contains("clock=10"));
        } else {
            panic!("Expected Log command");
        }
    }

    #[test]
    fn rules_engine_missing_script() {
        let engine = RulesScriptEngine::new();
        let game = make_game_view();
        let ctx = RulesContext::new(game, "GameStart".into(), HashMap::new(), HashMap::new());
        let result = engine.run_on_event("nonexistent", ctx);
        assert!(result.is_err());
    }

    #[test]
    fn rules_engine_compile_error() {
        let mut engine = RulesScriptEngine::new();
        let result = engine.compile_script("bad", "fn on_event(ctx { }"); // syntax error
        assert!(result.is_err());
    }

    // ── AiScriptEngine tests ────────────────────────────────────────
    // Tests use the LEGACY function names (the product-facing API).
    // This validates that existing saved scripts and shipped examples
    // will compile and run correctly against the new engine.

    #[test]
    fn ai_engine_example_chase_script() {
        // This is the shipped example_chase_ai from ScriptPanel.tsx.
        // It must compile and run without modification.
        let mut engine = AiScriptEngine::new();
        let source = r#"
            fn update(ctx) {
                let me = self_pos(ctx);
                let enemy = find_nearest(ctx, "enemy");

                if enemy < 0 {
                    set_animation(ctx, "idle");
                    return;
                }

                let pos = get_position(ctx, enemy);
                let d = dist_vec(me, pos);

                if d < 1.5 {
                    attack(ctx, enemy);
                    set_animation(ctx, "melee");
                } else if d < 15.0 {
                    move_to(ctx, pos.x, pos.y);
                    set_animation(ctx, "walk");
                } else {
                    set_animation(ctx, "idle");
                }
            }
        "#;
        engine.compile_script("chase_ai", source).expect("compile failed");

        // "enemy" is a computed relation: team_id differs from self_team.
        // Tags are empty — the adapter resolves "enemy" from team IDs,
        // not from pre-stamped strings on the DTO.
        let game = GameView {
            mode: "Tactical".into(),
            phase: "Exploration".into(),
            clock: 0.0, turn_number: 0, active_team_id: None,
            teams: vec![],
            characters: vec![
                CharacterView {
                    instance_id: 1, team_id: 0,
                    x: 5.0, y: 5.0,
                    stats: HashMap::new(), alive: true,
                    tags: vec![],
                },
                CharacterView {
                    instance_id: 2, team_id: 1,
                    x: 10.0, y: 5.0,
                    stats: HashMap::new(), alive: true,
                    tags: vec![],
                },
            ],
        };

        let ctx = CharacterAiContext::new(1, 0, Vec2::new(5.0, 5.0), HashMap::new(), 1.0 / 60.0, game);
        let cmds = engine.run_update("chase_ai", ctx).expect("run failed");
        // Distance ~5.0 → chase range → move_to + set_animation("walk")
        assert_eq!(cmds.len(), 2);
        assert!(matches!(&cmds[0], AiCommand::MoveTo(pos) if (pos.x - 10.0).abs() < 0.01));
        assert!(matches!(&cmds[1], AiCommand::SetAnimation(s) if s == "walk"));
    }

    #[test]
    fn ai_engine_example_patrol_script() {
        // This is the shipped example_patrol_ai from ScriptPanel.tsx.
        let mut engine = AiScriptEngine::new();
        let source = r#"
            fn update(ctx) {
                let me = self_pos(ctx);
                let ax = 3.0; let ay = 3.0;
                let bx = 12.0; let by = 12.0;

                let da = dist(me.x, me.y, ax, ay);
                let db = dist(me.x, me.y, bx, by);

                if da < 1.0 {
                    move_to(ctx, bx, by);
                } else if db < 1.0 {
                    move_to(ctx, ax, ay);
                } else if da < db {
                    move_to(ctx, ax, ay);
                } else {
                    move_to(ctx, bx, by);
                }
                set_animation(ctx, "walk");
            }
        "#;
        engine.compile_script("patrol_ai", source).expect("compile failed");

        let game = make_game_view();
        let ctx = CharacterAiContext::new(1, 0, Vec2::new(5.0, 5.0), HashMap::new(), 1.0 / 60.0, game);
        let cmds = engine.run_update("patrol_ai", ctx).expect("run failed");
        assert_eq!(cmds.len(), 2); // move_to + set_animation
        assert!(matches!(&cmds[0], AiCommand::MoveTo(_)));
        assert!(matches!(&cmds[1], AiCommand::SetAnimation(s) if s == "walk"));
    }

    #[test]
    fn ai_engine_all_commands() {
        let mut engine = AiScriptEngine::new();
        let source = r#"
            fn update(ctx) {
                move_to(ctx, 1.0, 2.0);
                attack(ctx, 5);
                face(ctx, "north");
                set_animation(ctx, "walk");
                set_velocity(ctx, 3.0, 4.0);
                play_sound(ctx, "boom");
            }
        "#;
        engine.compile_script("all_cmds", source).expect("compile failed");

        let game = make_game_view();
        let ctx = CharacterAiContext::new(1, 0, Vec2::ZERO, HashMap::new(), 1.0 / 60.0, game);
        let cmds = engine.run_update("all_cmds", ctx).expect("run failed");
        assert_eq!(cmds.len(), 6);
        assert!(matches!(&cmds[0], AiCommand::MoveTo(_)));
        assert!(matches!(&cmds[1], AiCommand::Attack(_)));
        assert!(matches!(&cmds[2], AiCommand::Face(d) if d == "north"));
        assert!(matches!(&cmds[3], AiCommand::SetAnimation(s) if s == "walk"));
        assert!(matches!(&cmds[4], AiCommand::SetVelocity(_)));
        assert!(matches!(&cmds[5], AiCommand::PlaySound(s) if s == "boom"));
    }

    #[test]
    fn ai_engine_extended_queries() {
        let mut engine = AiScriptEngine::new();
        let source = r#"
            fn update(ctx) {
                let id = self_id(ctx);
                let team = self_team(ctx);
                let delta = dt(ctx);
                let hp = self_stat(ctx, "hp");
                let enemy = find_nearest_enemy(ctx);
                // Encode values into velocity for assertion
                set_velocity(ctx, id.to_float() + team.to_float() * 100.0, hp + enemy.to_float() * 1000.0);
            }
        "#;
        engine.compile_script("ext_query", source).expect("compile failed");

        let mut stats = HashMap::new();
        stats.insert("hp".into(), 75.0);
        let game = make_game_view();
        let ctx = CharacterAiContext::new(1, 0, Vec2::new(5.0, 5.0), stats, 1.0 / 60.0, game);
        let cmds = engine.run_update("ext_query", ctx).expect("run failed");
        assert_eq!(cmds.len(), 1);
        if let AiCommand::SetVelocity(v) = &cmds[0] {
            // id=1, team=0 → x = 1 + 0*100 = 1
            assert!((v.x - 1.0).abs() < 0.01);
            // hp=75, nearest_enemy=2 → y = 75 + 2*1000 = 2075
            assert!((v.y - 2075.0).abs() < 0.01);
        } else {
            panic!("Expected SetVelocity command");
        }
    }

    #[test]
    fn ai_engine_utilities() {
        let mut engine = AiScriptEngine::new();
        let source = r#"
            fn update(ctx) {
                let d = dist(0.0, 0.0, 3.0, 4.0);
                let n = normalize(3.0, 4.0);
                let l = lerp(0.0, 10.0, 0.5);
                // d=5.0, n.x≈0.6, l=5.0 → encode into velocity
                set_velocity(ctx, d + l, n.x * 100.0);
            }
        "#;
        engine.compile_script("utils", source).expect("compile failed");

        let game = make_game_view();
        let ctx = CharacterAiContext::new(1, 0, Vec2::ZERO, HashMap::new(), 1.0 / 60.0, game);
        let cmds = engine.run_update("utils", ctx).expect("run failed");
        assert_eq!(cmds.len(), 1);
        if let AiCommand::SetVelocity(v) = &cmds[0] {
            // d=5, l=5 → x=10
            assert!((v.x - 10.0).abs() < 0.01);
            // n.x = 3/5 = 0.6 → y=60
            assert!((v.y - 60.0).abs() < 0.01);
        } else {
            panic!("Expected SetVelocity command");
        }
    }

    #[test]
    fn ai_engine_missing_script() {
        let engine = AiScriptEngine::new();
        let game = make_game_view();
        let ctx = CharacterAiContext::new(1, 0, Vec2::ZERO, HashMap::new(), 1.0 / 60.0, game);
        let result = engine.run_update("nonexistent", ctx);
        assert!(result.is_err());
    }

    #[test]
    fn ai_engine_compile_error() {
        let mut engine = AiScriptEngine::new();
        let result = engine.compile_script("bad", "fn update(ctx { }"); // syntax error
        assert!(result.is_err());
    }

    #[test]
    fn ai_engine_script_management() {
        let mut engine = AiScriptEngine::new();
        engine.compile_script("a", "fn update(ctx) {}").unwrap();
        engine.compile_script("b", "fn update(ctx) {}").unwrap();
        assert_eq!(engine.list_scripts().len(), 2);
        assert!(engine.has_script("a"));

        engine.remove_script("a");
        assert!(!engine.has_script("a"));
        assert_eq!(engine.list_scripts().len(), 1);

        engine.clear_scripts();
        assert_eq!(engine.list_scripts().len(), 0);
    }

    // ── WorldGenScriptEngine tests ──────────────────────────────────

    #[test]
    fn worldgen_engine_all_commands() {
        let mut engine = WorldGenScriptEngine::new();
        let source = r#"
            fn generate(ctx) {
                log(ctx, "starting world gen");
                place_tile(ctx, 0, 0, "grass", 0, 0);
                place_tile(ctx, 1, 0, "water", 0, 1);
                spawn_unit(ctx, "soldier", 0, 5.0, 5.0);
                define_zone(ctx, "spawn_a", 0, 0, 10, 10, "spawn", 0);
                define_zone(ctx, "encounter", 5, 5, 20, 20, "encounter", -1);
            }
        "#;
        engine.compile_script("test_gen", source).expect("compile failed");

        let ctx = WorldGenContext::new();
        let cmds = engine.run_generate("test_gen", ctx).expect("run failed");
        assert_eq!(cmds.len(), 6);
        assert!(matches!(&cmds[0], WorldGenCommand::Log(msg) if msg == "starting world gen"));
        assert!(matches!(&cmds[1], WorldGenCommand::PlaceTile { x: 0, y: 0, asset_id, layer: 0, variant: 0 } if asset_id == "grass"));
        assert!(matches!(&cmds[2], WorldGenCommand::PlaceTile { x: 1, y: 0, asset_id, layer: 0, variant: 1 } if asset_id == "water"));
        assert!(matches!(&cmds[3], WorldGenCommand::SpawnUnit { template_id, team_id: 0, .. } if template_id == "soldier"));
        assert!(matches!(&cmds[4], WorldGenCommand::DefineZone { name, zone_type, team_id: Some(0), .. } if name == "spawn_a" && zone_type == "spawn"));
        assert!(matches!(&cmds[5], WorldGenCommand::DefineZone { team_id: None, .. }));
    }

    #[test]
    fn worldgen_engine_procedural_grid() {
        let mut engine = WorldGenScriptEngine::new();
        let source = r#"
            fn generate(ctx) {
                for y in range(0, 5) {
                    for x in range(0, 5) {
                        let tile = if rand(0, 1) == 0 { "grass" } else { "dirt" };
                        place_tile(ctx, x, y, tile, 0, 0);
                    }
                }
            }
        "#;
        engine.compile_script("grid", source).expect("compile failed");

        let ctx = WorldGenContext::new();
        let cmds = engine.run_generate("grid", ctx).expect("run failed");
        assert_eq!(cmds.len(), 25); // 5x5 grid
        for cmd in &cmds {
            assert!(matches!(cmd, WorldGenCommand::PlaceTile { .. }));
        }
    }

    #[test]
    fn worldgen_engine_missing_script() {
        let engine = WorldGenScriptEngine::new();
        let ctx = WorldGenContext::new();
        assert!(engine.run_generate("nonexistent", ctx).is_err());
    }
}
