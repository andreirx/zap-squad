//! Character asset schemas — the single source of truth for character data.
//!
//! These types mirror the JSON schemas in `schemas/` and define the
//! authoritative contract for character assets at two stages:
//!
//! 1. **Source** (`CharacterSourceDef`) — what the editor produces before baking.
//!    Declares animations, directions, and frame counts explicitly.
//!    Frame image blobs are stored under stable logical keys derived from this:
//!    `characters/{id}/frames/{animation}/{direction}/{frame}.png`
//!
//! 2. **Baked** (`CharacterBakedDef`) — what the baker produces for the runtime.
//!    Atlas path, per-animation row/frame mapping, sprite registry keys.
//!
//! Both are pure data — no behavior, no dependencies, no IO.
//! Storage backends (IDB, disk, S3) are encoding details, not format definitions.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ── Source schema (pre-bake) ────────────────────────────────────────────

/// A character asset as authored in the editor, before baking.
/// This is the single source of truth for what frames exist.
///
/// Matches `schemas/character-source.schema.json` version 1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSourceDef {
    /// Schema version. Must be 1.
    pub version: u32,
    /// Unique identifier (lowercase, alphanumeric + underscores).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Sprite size in pixels (width = height). Typically 128.
    pub sprite_size: u32,
    /// Seconds per frame for animation playback.
    #[serde(default = "default_frame_duration")]
    pub frame_duration: f64,
    /// Optional weapon/object asset reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weapon_def_id: Option<String>,
    /// Optional throwable/object asset reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throwable_def_id: Option<String>,
    /// Animation declarations. Key is animation name (e.g., "idle", "walk").
    /// Each animation has per-direction frame counts.
    pub animations: BTreeMap<String, AnimationDirections>,
    /// ISO 8601 creation timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// ISO 8601 last modification timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

fn default_frame_duration() -> f64 {
    0.1
}

/// Per-direction frame declarations for one animation.
/// Each direction has an independent frame count.
/// `south` is required; others default to absent (not rendered for that direction).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnimationDirections {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub north: Option<DirectionFrames>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east: Option<DirectionFrames>,
    /// South is always present (minimum viable animation).
    pub south: DirectionFrames,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub west: Option<DirectionFrames>,
}

/// Frame count and loop setting for one animation+direction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectionFrames {
    /// Number of frames (1..=8). Blobs stored at indices 0..frames-1.
    pub frames: u32,
    /// Whether the animation loops. Defaults to true.
    #[serde(default = "default_true")]
    pub r#loop: bool,
}

fn default_true() -> bool {
    true
}

// ── Baked schema (post-bake, for runtime) ───────────────────────────────

/// A character asset after baking — consumed by the game runtime.
/// Derived from `CharacterSourceDef` + frame blobs by the baker crate.
///
/// Matches `schemas/character-baked.schema.json` version 1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBakedDef {
    /// Schema version. Must be 1.
    pub version: u32,
    /// Character identifier (matches source).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Relative path to atlas PNG from assets root.
    pub atlas: String,
    /// Atlas image width in pixels.
    pub atlas_width: u32,
    /// Atlas image height in pixels.
    pub atlas_height: u32,
    /// Sprite cell size in the atlas.
    pub sprite_size: u32,
    /// Default seconds per frame.
    #[serde(default = "default_frame_duration")]
    pub frame_duration: f64,
    /// Baked animation entries. Key: "{animation}_{direction}" (e.g., "idle_south").
    pub animations: BTreeMap<String, BakedAnimation>,
    /// Passthrough from source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weapon_def_id: Option<String>,
    /// Passthrough from source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throwable_def_id: Option<String>,
}

/// One animation+direction in the baked atlas.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BakedAnimation {
    /// Row index in the atlas (0-based).
    pub row: u32,
    /// Number of frames in this row (columns 0..frames-1).
    pub frames: u32,
    /// Whether this animation loops.
    pub r#loop: bool,
}

// ── Helpers ─────────────────────────────────────────────────────────────

impl CharacterSourceDef {
    /// Enumerate all (animation, direction, frame_index) triples declared
    /// in this definition. Used by the baker to validate blob existence
    /// and by the editor to iterate the frame set.
    pub fn frame_keys(&self) -> Vec<(String, String, u32)> {
        let mut keys = Vec::new();
        for (anim, dirs) in &self.animations {
            let dir_list: Vec<(&str, Option<&DirectionFrames>)> = vec![
                ("north", dirs.north.as_ref()),
                ("east", dirs.east.as_ref()),
                ("south", Some(&dirs.south)),
                ("west", dirs.west.as_ref()),
            ];
            for (dir_name, dir_frames) in dir_list {
                if let Some(df) = dir_frames {
                    for f in 0..df.frames {
                        keys.push((anim.clone(), dir_name.to_string(), f));
                    }
                }
            }
        }
        keys
    }

    /// Build the storage path for a frame blob relative to the asset root.
    /// E.g., `characters/hotdogguy/frames/idle/south/0.png`
    pub fn frame_path(id: &str, animation: &str, direction: &str, frame: u32) -> String {
        format!("characters/{}/frames/{}/{}/{}.png", id, animation, direction, frame)
    }

    /// Validate that the definition matches the schema constraints.
    /// Returns a list of error messages (empty = valid).
    ///
    /// Enforces: version, id regex, name non-empty, spriteSize enum,
    /// animation name regex, frame count range.
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();

        if self.version != 1 {
            errors.push(format!("unsupported version: {}", self.version));
        }
        if self.id.is_empty() {
            errors.push("id is empty".to_string());
        } else if !Self::is_valid_id(&self.id) {
            errors.push(format!("id '{}': must match ^[a-z][a-z0-9_]*$", self.id));
        }
        if self.name.is_empty() {
            errors.push("name is empty".to_string());
        }
        if !matches!(self.sprite_size, 64 | 128 | 256) {
            errors.push(format!("spriteSize must be 64, 128, or 256, got {}", self.sprite_size));
        }
        if self.animations.is_empty() {
            errors.push("no animations declared".to_string());
        }
        for (anim, dirs) in &self.animations {
            if !Self::is_valid_id(anim) {
                errors.push(format!("animation name '{}': must match ^[a-z][a-z0-9_]*$", anim));
            }
            let check_dir = |dir_name: &str, df: &DirectionFrames, errors: &mut Vec<String>| {
                if df.frames == 0 || df.frames > 8 {
                    errors.push(format!("{}/{}: frames must be 1..=8, got {}", anim, dir_name, df.frames));
                }
            };
            check_dir("south", &dirs.south, &mut errors);
            for (dir_name, dir_opt) in [("north", &dirs.north), ("east", &dirs.east), ("west", &dirs.west)] {
                if let Some(df) = dir_opt {
                    check_dir(dir_name, df, &mut errors);
                }
            }
        }

        errors
    }

    /// Check if a string matches the schema id pattern: ^[a-z][a-z0-9_]*$
    fn is_valid_id(s: &str) -> bool {
        let mut chars = s.chars();
        match chars.next() {
            Some(c) if c.is_ascii_lowercase() => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_source() -> CharacterSourceDef {
        let mut animations = BTreeMap::new();
        animations.insert("idle".to_string(), AnimationDirections {
            north: Some(DirectionFrames { frames: 1, r#loop: true }),
            east: Some(DirectionFrames { frames: 1, r#loop: true }),
            south: DirectionFrames { frames: 1, r#loop: true },
            west: Some(DirectionFrames { frames: 1, r#loop: true }),
        });
        animations.insert("walk".to_string(), AnimationDirections {
            north: Some(DirectionFrames { frames: 4, r#loop: true }),
            east: Some(DirectionFrames { frames: 4, r#loop: true }),
            south: DirectionFrames { frames: 4, r#loop: true },
            west: Some(DirectionFrames { frames: 4, r#loop: true }),
        });

        CharacterSourceDef {
            version: 1,
            id: "hotdogguy".to_string(),
            name: "Hot Dog Guy".to_string(),
            sprite_size: 128,
            frame_duration: 0.1,
            weapon_def_id: None,
            throwable_def_id: None,
            animations,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn source_serialization_roundtrip() {
        let def = sample_source();
        let json = serde_json::to_string_pretty(&def).unwrap();
        let parsed: CharacterSourceDef = serde_json::from_str(&json).unwrap();
        assert_eq!(def, parsed);
    }

    #[test]
    fn frame_keys_enumeration() {
        let def = sample_source();
        let keys = def.frame_keys();
        // idle: 4 directions × 1 frame = 4
        // walk: 4 directions × 4 frames = 16
        assert_eq!(keys.len(), 20);
        assert!(keys.contains(&("idle".to_string(), "south".to_string(), 0)));
        assert!(keys.contains(&("walk".to_string(), "east".to_string(), 3)));
    }

    #[test]
    fn frame_path_format() {
        let path = CharacterSourceDef::frame_path("hotdogguy", "walk", "south", 2);
        assert_eq!(path, "characters/hotdogguy/frames/walk/south/2.png");
    }

    #[test]
    fn validation_catches_empty_id() {
        let mut def = sample_source();
        def.id = String::new();
        let errors = def.validate();
        assert!(errors.iter().any(|e| e.contains("id is empty")));
    }

    #[test]
    fn validation_catches_zero_frames() {
        let mut def = sample_source();
        def.animations.get_mut("idle").unwrap().south.frames = 0;
        let errors = def.validate();
        assert!(errors.iter().any(|e| e.contains("idle/south")));
    }

    #[test]
    fn validation_catches_too_many_frames() {
        let mut def = sample_source();
        def.animations.get_mut("walk").unwrap().north.as_mut().unwrap().frames = 9;
        let errors = def.validate();
        assert!(errors.iter().any(|e| e.contains("walk/north")));
    }

    #[test]
    fn baked_serialization_roundtrip() {
        let mut animations = BTreeMap::new();
        animations.insert("idle_south".to_string(), BakedAnimation { row: 0, frames: 1, r#loop: true });
        animations.insert("walk_south".to_string(), BakedAnimation { row: 1, frames: 4, r#loop: true });

        let baked = CharacterBakedDef {
            version: 1,
            id: "hotdogguy".to_string(),
            name: "Hot Dog Guy".to_string(),
            atlas: "characters/hotdogguy.png".to_string(),
            atlas_width: 1024,
            atlas_height: 256,
            sprite_size: 128,
            frame_duration: 0.1,
            animations,
            weapon_def_id: None,
            throwable_def_id: None,
        };

        let json = serde_json::to_string_pretty(&baked).unwrap();
        let parsed: CharacterBakedDef = serde_json::from_str(&json).unwrap();
        assert_eq!(baked, parsed);
    }
}
