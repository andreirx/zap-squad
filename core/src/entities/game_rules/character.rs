//! Character entities for the game rules layer.
//!
//! Characters exist at two levels:
//! - **Templates**: define a unit type (e.g., "Marine", "Zombie", "Wizard").
//!   Fungible — many instances can be spawned from one template.
//! - **Instances**: individual characters in the world with their own stats,
//!   experience, and identity. Can evolve independently from their template.

use serde::{Deserialize, Serialize};
use super::types::{Stats, TeamId};
use crate::entities::ActorId;

/// Stable domain-level identity for a character instance.
/// Decoupled from ActorId (renderer lifecycle). Persists across saves,
/// survives off-board status, reinforcement pooling, etc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CharacterInstanceId(pub u32);

/// Unique identifier for a character template.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TemplateId(pub String);

/// A character template — defines a unit type.
///
/// Templates hold base stats and the body sprite reference.
/// Spawning a character from a template creates an instance
/// with a copy of these base stats. The instance can then
/// evolve independently (gain experience, take damage, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterTemplate {
    pub id: TemplateId,
    pub name: String,
    /// Reference to the visual asset (body_def_id for CompositeActor).
    pub body_def_id: String,
    /// Base stats copied to new instances.
    pub base_stats: Stats,
    /// Optional weapon equipped by default.
    pub weapon_def_id: Option<String>,
    /// Optional throwable/ranged object equipped by default.
    pub throwable_def_id: Option<String>,
    /// Tags for AI targeting (e.g., "infantry", "building", "creep").
    pub tags: Vec<String>,
}

/// A character instance — an individual character in the game world.
///
/// Identified by `id` (domain-level, stable, persists across saves).
/// Optionally linked to a CompositeActor (rendering) via `actor_id`.
/// The game rules layer owns stats and team; rendering owns position and animation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterInstance {
    /// Stable domain identity. Survives save/load, off-board status, pooling.
    pub id: CharacterInstanceId,
    /// Optional link to the CompositeActor in the rendering system.
    /// None when the character is off-board (reserves, reinforcement pool, dead-but-tracked).
    pub actor_id: Option<ActorId>,
    /// Team this character belongs to.
    pub team_id: TeamId,
    /// Template this character was spawned from (if any).
    pub template_id: Option<TemplateId>,
    /// Live stats — starts as a copy of template base_stats, evolves independently.
    pub stats: Stats,
    /// Whether this is an individual (persistent identity, XP, permadeath)
    /// or fungible (disposable, no persistence beyond the current session).
    pub individual: bool,
    /// Optional name for individuals (e.g., "Sgt. Rodriguez").
    pub name: Option<String>,
    /// Script assigned to this character's AI behavior.
    pub ai_script: Option<String>,
    /// Whether this character is alive. Dead characters remain in the list
    /// until explicitly removed (for death animations, loot, etc.).
    pub alive: bool,
}

impl CharacterInstance {
    /// Create a new instance from a template.
    pub fn from_template(
        id: CharacterInstanceId,
        team_id: TeamId,
        template: &CharacterTemplate,
        individual: bool,
    ) -> Self {
        Self {
            id,
            actor_id: None,
            team_id,
            template_id: Some(template.id.clone()),
            stats: template.base_stats.clone(),
            individual,
            name: None,
            ai_script: None,
            alive: true,
        }
    }

    /// Create a standalone instance (no template).
    pub fn standalone(id: CharacterInstanceId, team_id: TeamId, stats: Stats) -> Self {
        Self {
            id,
            actor_id: None,
            team_id,
            template_id: None,
            stats,
            individual: true,
            name: None,
            ai_script: None,
            alive: true,
        }
    }

    /// Link this instance to a rendered actor on the board.
    pub fn attach_actor(&mut self, actor_id: ActorId) {
        self.actor_id = Some(actor_id);
    }

    /// Detach from rendered actor (going off-board).
    pub fn detach_actor(&mut self) {
        self.actor_id = None;
    }

    /// Get a stat value, returning 0.0 if not defined.
    pub fn stat(&self, key: &str) -> f32 {
        self.stats.get(key).copied().unwrap_or(0.0)
    }

    /// Modify a stat value. Returns the new value after modification.
    pub fn modify_stat(&mut self, key: &str, delta: f32) -> f32 {
        let val = self.stats.entry(key.to_string()).or_insert(0.0);
        *val += delta;
        *val
    }

    /// Set a stat to an exact value.
    pub fn set_stat(&mut self, key: &str, value: f32) {
        self.stats.insert(key.to_string(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_template() -> CharacterTemplate {
        let mut stats = Stats::new();
        stats.insert("hp".into(), 100.0);
        stats.insert("ap".into(), 4.0);
        stats.insert("accuracy".into(), 65.0);

        CharacterTemplate {
            id: TemplateId("marine".into()),
            name: "Marine".into(),
            body_def_id: "carnat_test".into(),
            base_stats: stats,
            weapon_def_id: Some("rifle".into()),
            throwable_def_id: None,
            tags: vec!["infantry".into()],
        }
    }

    #[test]
    fn instance_from_template() {
        let tmpl = make_template();
        let inst = CharacterInstance::from_template(CharacterInstanceId(1), TeamId(0), &tmpl, false);

        assert_eq!(inst.stat("hp"), 100.0);
        assert_eq!(inst.stat("ap"), 4.0);
        assert!(!inst.individual);
        assert!(inst.alive);
        assert!(inst.actor_id.is_none()); // not on board yet
    }

    #[test]
    fn modify_stat() {
        let tmpl = make_template();
        let mut inst = CharacterInstance::from_template(CharacterInstanceId(1), TeamId(0), &tmpl, true);

        inst.modify_stat("hp", -30.0);
        assert_eq!(inst.stat("hp"), 70.0);

        inst.modify_stat("xp", 50.0); // stat didn't exist, created with 0 + 50
        assert_eq!(inst.stat("xp"), 50.0);
    }

    #[test]
    fn individual_has_name() {
        let mut inst = CharacterInstance::standalone(CharacterInstanceId(1), TeamId(0), Stats::new());
        inst.name = Some("Sgt. Rodriguez".into());
        assert_eq!(inst.name.as_deref(), Some("Sgt. Rodriguez"));
    }
}
