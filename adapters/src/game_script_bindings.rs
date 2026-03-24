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

    // -- Query methods exposed to Rhai --

    pub fn query_self_id(&self) -> i64 { self.self_id as i64 }
    pub fn query_self_team(&self) -> i64 { self.self_team as i64 }
    pub fn query_self_x(&self) -> f64 { self.self_pos.x as f64 }
    pub fn query_self_y(&self) -> f64 { self.self_pos.y as f64 }
    pub fn query_dt(&self) -> f64 { self.dt as f64 }

    pub fn query_self_stat(&self, key: String) -> f64 {
        self.self_stats.get(&key).copied().unwrap_or(0.0) as f64
    }

    pub fn query_find_nearest_enemy(&self) -> i64 {
        let mut best_id: i64 = -1;
        let mut best_dist = f64::MAX;
        for c in &self.game.characters {
            if c.team_id != self.self_team && c.alive {
                let dx = c.x as f64 - self.self_pos.x as f64;
                let dy = c.y as f64 - self.self_pos.y as f64;
                let dist = dx * dx + dy * dy;
                if dist < best_dist {
                    best_dist = dist;
                    best_id = c.instance_id as i64;
                }
            }
        }
        best_id
    }

    pub fn query_get_pos(&self, id: i64) -> (f64, f64) {
        for c in &self.game.characters {
            if c.instance_id == id as u32 {
                return (c.x as f64, c.y as f64);
            }
        }
        (0.0, 0.0)
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
}
