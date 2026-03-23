//! Fundamental types used across the game rules domain.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Unique team identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct TeamId(pub u32);

/// How time advances in this game.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameMode {
    /// Continuous real-time. Clock advances by dt every frame.
    /// No pausing for decisions. (Bloons TD, StarCraft)
    RealTime,

    /// Real-time exploration, auto-pause on encounter.
    /// During encounter: simultaneous decision phase → resolution plays out → repeat.
    /// (KOTOR, modern XCOM)
    Tactical,

    /// Fully turn-based. Each team takes turns. Clock advances by action.
    /// (Classic XCOM, Fire Emblem, Civilization)
    TurnBased,
}

/// Which phase of the game session is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GamePhase {
    /// Pre-game setup. World generation scripts run. Players place starting units.
    Setup,

    /// Real-time exploration/movement. Characters move freely.
    /// In Tactical mode, encountering enemies transitions to EncounterDecision.
    Exploration,

    /// Encounter detected (Tactical mode only). Game is paused.
    /// Players and AI choose actions for their characters.
    EncounterDecision,

    /// Actions are resolved and animated. No input accepted.
    /// After resolution, returns to EncounterDecision (if enemies remain)
    /// or Exploration (if encounter is over).
    EncounterResolution,

    /// One team is taking their turn (TurnBased mode).
    Turn { team: TeamId },

    /// Game over. Winner determined.
    Ended { winner: Option<TeamId> },
}

/// Flexible key-value stats. Schema defined per game mode.
/// Characters, teams, and the game itself can carry stats.
pub type Stats = HashMap<String, f32>;

/// A stat schema entry — defines one stat's metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatDef {
    /// Stat key used in HashMap lookups (e.g., "hp", "courage", "psi").
    pub key: String,
    /// Human-readable display name (e.g., "Hit Points", "Courage").
    pub display_name: String,
    /// Default value for new characters.
    pub default_value: f32,
    /// Minimum allowed value (e.g., 0 for hp).
    pub min_value: f32,
    /// Maximum allowed value (e.g., 100 for accuracy).
    pub max_value: f32,
    /// Whether this stat is visible to the player who owns the character.
    pub visible: bool,
    /// Whether this stat is visible to opposing teams.
    pub visible_to_enemies: bool,
}

impl StatDef {
    pub fn new(key: impl Into<String>, display_name: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            display_name: display_name.into(),
            default_value: 0.0,
            min_value: f32::NEG_INFINITY,
            max_value: f32::INFINITY,
            visible: true,
            visible_to_enemies: false,
        }
    }

    pub fn with_range(mut self, default: f32, min: f32, max: f32) -> Self {
        self.default_value = default;
        self.min_value = min;
        self.max_value = max;
        self
    }

    pub fn hidden(mut self) -> Self {
        self.visible = false;
        self
    }

    pub fn hidden_from_enemies(mut self) -> Self {
        self.visible_to_enemies = false;
        self
    }
}

/// The full stat schema for a game mode.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatSchema {
    pub stats: Vec<StatDef>,
}

impl StatSchema {
    pub fn new() -> Self {
        Self { stats: Vec::new() }
    }

    pub fn add(mut self, stat: StatDef) -> Self {
        self.stats.push(stat);
        self
    }

    /// Create a default Stats HashMap from this schema.
    pub fn default_stats(&self) -> Stats {
        self.stats.iter().map(|s| (s.key.clone(), s.default_value)).collect()
    }

    /// Clamp all stats in the map to their schema-defined ranges.
    pub fn clamp(&self, stats: &mut Stats) {
        for def in &self.stats {
            if let Some(val) = stats.get_mut(&def.key) {
                *val = val.clamp(def.min_value, def.max_value);
            }
        }
    }

    /// Check if a stat key exists in this schema.
    pub fn has(&self, key: &str) -> bool {
        self.stats.iter().any(|s| s.key == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_schema_defaults() {
        let schema = StatSchema::new()
            .add(StatDef::new("hp", "Hit Points").with_range(100.0, 0.0, 999.0))
            .add(StatDef::new("ap", "Action Points").with_range(4.0, 0.0, 10.0))
            .add(StatDef::new("psi", "Psionic Power").with_range(0.0, 0.0, 100.0).hidden());

        let stats = schema.default_stats();
        assert_eq!(stats["hp"], 100.0);
        assert_eq!(stats["ap"], 4.0);
        assert_eq!(stats["psi"], 0.0);
    }

    #[test]
    fn stat_clamp() {
        let schema = StatSchema::new()
            .add(StatDef::new("hp", "HP").with_range(100.0, 0.0, 100.0));

        let mut stats = schema.default_stats();
        stats.insert("hp".into(), 150.0);
        schema.clamp(&mut stats);
        assert_eq!(stats["hp"], 100.0);

        stats.insert("hp".into(), -10.0);
        schema.clamp(&mut stats);
        assert_eq!(stats["hp"], 0.0);
    }
}
