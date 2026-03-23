//! Game definition — the JSON-serializable description of a playable game.
//!
//! A game definition is created by the game rules editor and stored
//! alongside the world data. It describes everything needed to play:
//! teams, stats, resources, character templates, scripts, and win conditions.

use serde::{Deserialize, Serialize};
use super::types::{GameMode, StatSchema, TeamId};
use super::team::TeamDefinition;
use super::character::CharacterTemplate;
use super::resource::ResourceSchema;

/// A named rectangular zone on the map (spawn point, encounter area, extraction point).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Zone {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// What this zone is for.
    pub zone_type: ZoneType,
    /// Which team this zone belongs to (if applicable).
    pub team_id: Option<TeamId>,
}

/// Purpose of a zone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ZoneType {
    /// Characters can be spawned here.
    SpawnPoint,
    /// Entering this zone triggers an encounter (Tactical mode).
    EncounterArea,
    /// Reaching this zone completes an objective.
    ExtractionPoint,
    /// Enemies spawn here in waves (tower defense).
    WaveSource,
    /// Resource producer location.
    ResourceProducer { resource_key: String, rate: f32 },
    /// Generic named zone for script use.
    Custom,
}

/// A path that enemies follow (tower defense wave lanes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WavePath {
    pub name: String,
    /// Ordered waypoints (tile coordinates).
    pub waypoints: Vec<(i32, i32)>,
}

/// Binding between game rules and a specific world/playground.
///
/// Describes WHERE on the map things happen — spawn points, encounter zones,
/// resource producers, wave paths. Without this, rules are abstract;
/// with it, validation can answer "can this game be played HERE?"
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorldBinding {
    /// Named zones on the map.
    pub zones: Vec<Zone>,
    /// Wave paths for tower defense (enemies follow these).
    pub wave_paths: Vec<WavePath>,
    /// Name of the freedom-board world save this game runs on.
    pub world_name: Option<String>,
}

/// What condition ends the game.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WinCondition {
    /// Last team standing (all other teams eliminated).
    Elimination,
    /// First team to reach a resource threshold wins.
    ResourceThreshold { resource_key: String, amount: f32 },
    /// Survive N turns/waves.
    Survival { turns_or_waves: u32 },
    /// Custom condition evaluated by rules script.
    Custom { condition_name: String },
}

/// Complete game definition — everything needed to start a game session.
///
/// This is the output of the game rules editor.
/// Serialized as JSON and stored alongside the world in IDB.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameDefinition {
    /// Human-readable game name.
    pub name: String,
    /// Description of the game mode.
    pub description: String,
    /// How time works in this game.
    pub mode: GameMode,
    /// Teams participating in the game.
    pub teams: Vec<TeamDefinition>,
    /// Which stats characters have.
    pub stat_schema: StatSchema,
    /// Which resources teams have.
    pub resource_schema: ResourceSchema,
    /// Character templates available for spawning.
    pub character_templates: Vec<CharacterTemplate>,
    /// How the game is won.
    pub win_conditions: Vec<WinCondition>,
    /// Name of the rules Rhai script (handles game events).
    pub rules_script: String,
    /// Name of the world generation Rhai script (runs during Setup phase).
    pub world_gen_script: Option<String>,
    /// Binding to a specific world — zones, spawn points, wave paths.
    #[serde(default)]
    pub world_binding: WorldBinding,
}

impl GameDefinition {
    pub fn new(name: impl Into<String>, mode: GameMode) -> Self {
        Self {
            name: name.into(),
            description: String::new(),
            mode,
            teams: Vec::new(),
            stat_schema: StatSchema::new(),
            resource_schema: ResourceSchema::new(),
            character_templates: Vec::new(),
            win_conditions: Vec::new(),
            rules_script: "default_rules".into(),
            world_gen_script: None,
            world_binding: WorldBinding::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::StatDef;
    use super::super::resource::ResourceDef;

    #[test]
    fn build_game_definition() {
        let game = GameDefinition {
            name: "XCOM Demo".into(),
            description: "Turn-based tactics demo".into(),
            mode: GameMode::Tactical,
            teams: vec![],
            stat_schema: StatSchema::new()
                .add(StatDef::new("hp", "Hit Points").with_range(100.0, 0.0, 999.0))
                .add(StatDef::new("ap", "Action Points").with_range(4.0, 0.0, 10.0))
                .add(StatDef::new("psi", "Psionic Power").with_range(0.0, 0.0, 100.0).hidden()),
            resource_schema: ResourceSchema::new()
                .add(ResourceDef::new("supplies", "Supplies").with_start(100.0)),
            character_templates: vec![],
            win_conditions: vec![WinCondition::Elimination],
            rules_script: "xcom_rules".into(),
            world_gen_script: Some("xcom_worldgen".into()),
            world_binding: WorldBinding::default(),
        };

        assert_eq!(game.name, "XCOM Demo");
        assert_eq!(game.mode, GameMode::Tactical);
        assert_eq!(game.stat_schema.stats.len(), 3);
        assert_eq!(game.resource_schema.resources.len(), 1);
    }
}
