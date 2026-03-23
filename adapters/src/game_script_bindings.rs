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
    pub event_data: HashMap<String, f64>,
    commands: Arc<Mutex<Vec<RulesCommand>>>,
}

impl RulesContext {
    pub fn new(game: GameView, event_name: String, event_data: HashMap<String, f64>) -> Self {
        Self {
            game,
            event_name,
            event_data,
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
        let ctx = RulesContext::new(game, "on_game_start".into(), HashMap::new());
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
}
