//! Team entities — who plays the game and how.

use serde::{Deserialize, Serialize};
use super::types::{Stats, TeamId};

/// How a team is controlled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TeamController {
    /// Human player making decisions via UI.
    Human,
    /// CPU-controlled via a Rhai AI script.
    Cpu { script_name: String },
}

/// Static team definition (from game definition JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamDefinition {
    pub id: TeamId,
    pub name: String,
    pub controller: TeamController,
    /// Color for UI rendering (hex string, e.g., "#e94560").
    pub color: String,
}

/// Team relation — how two teams interact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TeamRelation {
    /// Teams fight each other.
    Hostile,
    /// Teams cooperate (shared vision, no friendly fire).
    Allied,
    /// Neutral — no auto-attack, but can be attacked.
    Neutral,
}

/// Runtime team state during a game session.
#[derive(Debug, Clone)]
pub struct TeamState {
    pub id: TeamId,
    pub name: String,
    pub controller: TeamController,
    pub color: String,
    /// Per-team resources (gold, minerals, supply, etc.).
    pub resources: Stats,
    /// Whether this team has been eliminated.
    pub eliminated: bool,
}

impl TeamState {
    pub fn from_definition(def: &TeamDefinition) -> Self {
        Self {
            id: def.id,
            name: def.name.clone(),
            controller: def.controller.clone(),
            color: def.color.clone(),
            resources: Stats::new(),
            eliminated: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_from_definition() {
        let def = TeamDefinition {
            id: TeamId(1),
            name: "Red Army".into(),
            controller: TeamController::Human,
            color: "#e94560".into(),
        };
        let state = TeamState::from_definition(&def);
        assert_eq!(state.id, TeamId(1));
        assert_eq!(state.name, "Red Army");
        assert!(!state.eliminated);
        assert!(state.resources.is_empty());
    }
}
