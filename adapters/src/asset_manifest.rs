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
    /// Format: "{body_id}/{anim}_{direction}/{frame}"
    /// Matches assets.json format from convert-manifest.ts
    pub fn sprite_name(
        &self,
        direction: Direction,
        animation: AnimationState,
        _visual: VisualState, // Currently unused in sprite names
        frame: u32,
    ) -> String {
        format!(
            "{}/{}/{}",
            self.id,
            animation_direction_key(animation, direction),
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
    /// Format: "{weapon_id}/{anim}_{direction}/{frame}"
    /// Matches assets.json format from convert-manifest.ts
    pub fn sprite_name(&self, direction: Direction, animation: AnimationState, frame: u32) -> String {
        format!(
            "{}/{}/{}",
            self.id,
            animation_direction_key(animation, direction),
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

/// Raw game manifest format (as stored in manifest.json)
#[derive(Debug, Deserialize)]
struct RawGameManifest {
    #[serde(default)]
    characters: HashMap<String, RawCharacterDef>,
    #[serde(default)]
    weapons: HashMap<String, RawWeaponDef>,
}

#[derive(Debug, Deserialize)]
struct RawCharacterDef {
    id: String,
    name: String,
    #[serde(default)]
    animations: HashMap<String, RawAnimation>,
}

#[derive(Debug, Deserialize)]
struct RawAnimation {
    frames: u32,
    #[serde(default = "default_loop")]
    r#loop: bool,
}

fn default_loop() -> bool { true }

#[derive(Debug, Deserialize)]
struct RawWeaponDef {
    id: String,
    name: String,
    #[serde(default)]
    animations: HashMap<String, RawAnimation>,
    #[serde(rename = "anchorX", default)]
    anchor_x: f32,
    #[serde(rename = "anchorY", default)]
    anchor_y: f32,
}

impl AssetManifest {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load manifest from internal JSON format (bodies, weapons, etc.)
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Load manifest from game manifest.json format (characters, tiles, weapons)
    /// This adapts the game format to the internal AssetManifest format
    pub fn from_game_manifest(json: &str) -> Result<Self, serde_json::Error> {
        let raw: RawGameManifest = serde_json::from_str(json)?;
        let mut manifest = AssetManifest::new();

        // Convert characters to bodies
        for (id, char_def) in raw.characters {
            // Determine max frames from animations
            let max_frames = char_def.animations.values()
                .map(|a| a.frames)
                .max()
                .unwrap_or(1);

            manifest.add_body(BodyDefinition {
                id,
                name: char_def.name,
                frames_per_state: max_frames,
                frame_duration: 0.1, // Default frame duration
                weapon_anchors: HashMap::new(),
            });
        }

        // Convert weapons
        for (id, weapon_def) in raw.weapons {
            let max_frames = weapon_def.animations.values()
                .map(|a| a.frames)
                .max()
                .unwrap_or(1);

            let mut offsets = HashMap::new();
            // Apply anchor as default offset for all directions
            let anchor = Vec2::new(weapon_def.anchor_x, weapon_def.anchor_y);
            for dir in ["up", "down", "left", "right"] {
                offsets.insert(dir.to_string(), anchor);
            }

            manifest.add_weapon(WeaponDefinition {
                id,
                name: weapon_def.name,
                weapon_type: WeaponType::Melee, // Default, could be determined from name
                frames_per_state: max_frames,
                frame_duration: 0.1,
                offsets,
            });
        }

        Ok(manifest)
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

/// Generate animation_direction key matching manifest.json format
/// Examples: "idle_south", "walk_east", "melee_attack_north"
fn animation_direction_key(animation: AnimationState, direction: Direction) -> String {
    format!("{}_{}", animation_key(animation), compass_direction_key(direction))
}

/// AnimationState to manifest.json animation name
fn animation_key(animation: AnimationState) -> &'static str {
    match animation {
        AnimationState::Idle => "idle",
        AnimationState::Walk => "walk",
        AnimationState::MeleeAttack => "melee_attack",
        AnimationState::ThrowAttack => "throw_attack",
    }
}

/// Direction to compass direction (matches manifest.json)
fn compass_direction_key(direction: Direction) -> &'static str {
    match direction {
        Direction::North => "north",
        Direction::East => "east",
        Direction::South => "south",
        Direction::West => "west",
    }
}

/// Direction to screen direction (for anchor lookups)
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
        // Format: "{id}/{animation}_{direction}/{frame}"
        assert_eq!(name, "soldier/walk_south/2");
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
        // Format: "{id}/{animation}_{direction}/{frame}"
        assert_eq!(name, "sword/melee_attack_east/1");
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
