//! Asset Manifest - Definitions for bodies, weapons, and other assets
//!
//! The manifest describes all available assets and how to resolve
//! sprite keys to actual sprite names in the engine's registry.

use glam::Vec2;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use zapsquad_core::{AnimationState, Direction, VisualState};

/// Body definition - describes a character's body sprites
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BodyDefinition {
    pub id: String,
    pub name: String,
    /// Number of animation frames per state
    pub frames_per_state: u32,
    /// Frame duration in seconds
    pub frame_duration: f32,
    /// Weapon attachment anchor points per direction
    #[serde(default)]
    pub weapon_anchors: HashMap<String, Vec2>,
}

impl BodyDefinition {
    /// Resolve sprite name for given state
    /// Format: "{body_id}_{visual}_{anim}_{direction}_{frame}"
    pub fn sprite_name(
        &self,
        direction: Direction,
        animation: AnimationState,
        visual: VisualState,
        frame: u32,
    ) -> String {
        format!(
            "{}_{}_{}",
            self.id,
            sprite_key(direction, animation, visual),
            frame
        )
    }

    /// Get weapon anchor for direction
    pub fn weapon_anchor(&self, direction: Direction) -> Vec2 {
        let key = direction_key(direction);
        self.weapon_anchors.get(key).copied().unwrap_or(Vec2::ZERO)
    }
}

/// Weapon definition - describes a weapon's sprites
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeaponDefinition {
    pub id: String,
    pub name: String,
    pub weapon_type: WeaponType,
    /// Number of animation frames per state
    pub frames_per_state: u32,
    /// Frame duration in seconds
    pub frame_duration: f32,
    /// Offset from body anchor per direction
    #[serde(default)]
    pub offsets: HashMap<String, Vec2>,
}

impl WeaponDefinition {
    /// Resolve sprite name for given state
    /// Format: "{weapon_id}_{anim}_{direction}_{frame}"
    pub fn sprite_name(&self, direction: Direction, animation: AnimationState, frame: u32) -> String {
        format!(
            "{}_{}_{}",
            self.id,
            weapon_sprite_key(direction, animation),
            frame
        )
    }

    /// Get offset for direction
    pub fn offset(&self, direction: Direction) -> Vec2 {
        let key = direction_key(direction);
        self.offsets.get(key).copied().unwrap_or(Vec2::ZERO)
    }
}

/// Type of weapon
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum WeaponType {
    #[default]
    Melee,
    Ranged,
    Throwable,
}

/// Throwable definition - describes a projectile's sprites
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThrowableDefinition {
    pub id: String,
    pub name: String,
    /// Number of flight animation frames
    pub flight_frames: u32,
    /// Frame duration in seconds
    pub frame_duration: f32,
}

impl ThrowableDefinition {
    /// Resolve sprite name for flight animation
    pub fn sprite_name(&self, frame: u32) -> String {
        format!("{}_flight_{}", self.id, frame)
    }
}

/// Complete asset manifest
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssetManifest {
    pub bodies: HashMap<String, BodyDefinition>,
    pub weapons: HashMap<String, WeaponDefinition>,
    pub throwables: HashMap<String, ThrowableDefinition>,
    /// Script sources keyed by name
    pub scripts: HashMap<String, String>,
    /// Level file paths
    pub levels: Vec<String>,
}

impl AssetManifest {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load manifest from JSON
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Serialize to JSON
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// Get body definition by ID
    pub fn get_body(&self, id: &str) -> Option<&BodyDefinition> {
        self.bodies.get(id)
    }

    /// Get weapon definition by ID
    pub fn get_weapon(&self, id: &str) -> Option<&WeaponDefinition> {
        self.weapons.get(id)
    }

    /// Get throwable definition by ID
    pub fn get_throwable(&self, id: &str) -> Option<&ThrowableDefinition> {
        self.throwables.get(id)
    }

    /// Register a body definition
    pub fn add_body(&mut self, def: BodyDefinition) {
        self.bodies.insert(def.id.clone(), def);
    }

    /// Register a weapon definition
    pub fn add_weapon(&mut self, def: WeaponDefinition) {
        self.weapons.insert(def.id.clone(), def);
    }

    /// Register a script
    pub fn add_script(&mut self, name: impl Into<String>, source: impl Into<String>) {
        self.scripts.insert(name.into(), source.into());
    }
}

/// Generate sprite key for body: "{visual}_{anim}_{direction}"
fn sprite_key(direction: Direction, animation: AnimationState, visual: VisualState) -> String {
    format!(
        "{}_{}_{}",
        visual.as_str(),
        animation.as_str(),
        direction_key(direction)
    )
}

/// Generate sprite key for weapon: "{anim}_{direction}"
fn weapon_sprite_key(direction: Direction, animation: AnimationState) -> String {
    format!("{}_{}", animation.as_str(), direction_key(direction))
}

/// Direction to string key
fn direction_key(direction: Direction) -> &'static str {
    match direction {
        Direction::North => "up",
        Direction::East => "right",
        Direction::South => "down",
        Direction::West => "left",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_sprite_name() {
        let body = BodyDefinition {
            id: "soldier".to_string(),
            name: "Soldier".to_string(),
            frames_per_state: 4,
            frame_duration: 0.1,
            weapon_anchors: HashMap::new(),
        };

        let name = body.sprite_name(
            Direction::South,
            AnimationState::Walk,
            VisualState::Full,
            2,
        );
        assert_eq!(name, "soldier_full_walk_down_2");
    }

    #[test]
    fn weapon_sprite_name() {
        let weapon = WeaponDefinition {
            id: "sword".to_string(),
            name: "Sword".to_string(),
            weapon_type: WeaponType::Melee,
            frames_per_state: 4,
            frame_duration: 0.1,
            offsets: HashMap::new(),
        };

        let name = weapon.sprite_name(Direction::East, AnimationState::MeleeAttack, 1);
        assert_eq!(name, "sword_melee_attack_right_1");
    }

    #[test]
    fn manifest_json_roundtrip() {
        let mut manifest = AssetManifest::new();
        manifest.add_body(BodyDefinition {
            id: "test".to_string(),
            name: "Test".to_string(),
            frames_per_state: 4,
            frame_duration: 0.1,
            weapon_anchors: HashMap::new(),
        });

        let json = manifest.to_json().unwrap();
        let loaded = AssetManifest::from_json(&json).unwrap();

        assert!(loaded.get_body("test").is_some());
    }

    #[test]
    fn weapon_anchor_and_offset() {
        let mut anchors = HashMap::new();
        anchors.insert("right".to_string(), Vec2::new(10.0, 5.0));

        let body = BodyDefinition {
            id: "soldier".to_string(),
            name: "Soldier".to_string(),
            frames_per_state: 4,
            frame_duration: 0.1,
            weapon_anchors: anchors,
        };

        assert_eq!(body.weapon_anchor(Direction::East), Vec2::new(10.0, 5.0));
        assert_eq!(body.weapon_anchor(Direction::West), Vec2::ZERO); // Default
    }
}
