//! WASM Baker — authoritative transformation from CharacterSourceDef to baked outputs.
//!
//! This crate handles validation, atlas layout planning, and metadata generation
//! for character assets. Image compositing is done on the JS side via Canvas API;
//! this crate produces the plan that tells JS where to place each frame.
//!
//! # Exports
//!
//! - `validate_source(json)` — validate a CharacterSourceDef
//! - `plan_atlas(source_json)` — compute atlas layout (frame placements)
//! - `generate_baked_def(source_json, atlas_path)` — produce a CharacterBakedDef
//! - `generate_sprite_entries(source_json, atlas_index)` — produce sprite registry entries
//!
//! All inputs and outputs are JSON strings across the WASM boundary.
//! Every export returns a unified envelope: `{ "ok": <data> }` or `{ "error": "<msg>" }`.
//! Derivation exports (plan/generate) validate the source before proceeding — they
//! will not produce outputs from schema-invalid input.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zapsquad_core::entities::asset_schema::{
    AnimationDirections, BakedAnimation, CharacterBakedDef, CharacterSourceDef, DirectionFrames,
};

// ── Initialization ──────────────────────────────────────────────────────

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

// ── Atlas planning ──────────────────────────────────────────────────────

/// Where to place a single frame in the atlas.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FramePlacement {
    /// Animation name (e.g., "idle")
    animation: String,
    /// Direction (e.g., "south")
    direction: String,
    /// Frame index within this animation+direction
    frame: u32,
    /// Column in the atlas grid (0-based)
    col: u32,
    /// Row in the atlas grid (0-based)
    row: u32,
}

/// Complete atlas layout plan.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AtlasPlan {
    /// Atlas width in pixels
    width: u32,
    /// Atlas height in pixels
    height: u32,
    /// Number of columns in the grid
    cols: u32,
    /// Number of rows in the grid
    rows: u32,
    /// Sprite cell size
    sprite_size: u32,
    /// Where each frame goes
    placements: Vec<FramePlacement>,
}

const DIRECTIONS: &[&str] = &["north", "east", "south", "west"];
const MAX_COLS: u32 = 8;

fn get_dir_frames<'a>(dirs: &'a AnimationDirections, dir: &str) -> Option<&'a DirectionFrames> {
    match dir {
        "north" => dirs.north.as_ref(),
        "east" => dirs.east.as_ref(),
        "south" => Some(&dirs.south),
        "west" => dirs.west.as_ref(),
        _ => None,
    }
}

/// Build the atlas layout: one row per animation+direction that has frames.
/// Uses `sorted_anim_dir_rows()` for deterministic row ordering — same
/// function used by `generate_baked_def()` so row indices can never diverge.
fn build_atlas_plan(def: &CharacterSourceDef) -> AtlasPlan {
    let rows = sorted_anim_dir_rows(def);
    let num_rows = rows.len() as u32;
    let sprite_size = def.sprite_size;

    let mut placements = Vec::new();
    for (row_idx, (anim, dir, frame_count, _)) in rows.iter().enumerate() {
        for f in 0..*frame_count {
            placements.push(FramePlacement {
                animation: anim.clone(),
                direction: dir.clone(),
                frame: f,
                col: f,
                row: row_idx as u32,
            });
        }
    }

    AtlasPlan {
        width: MAX_COLS * sprite_size,
        height: num_rows * sprite_size,
        cols: MAX_COLS,
        rows: num_rows,
        sprite_size,
        placements,
    }
}

// ── Result envelope ──────────────────────────────────────────────────────
// Every WASM export returns JSON in this shape:
//   Success: { "ok": <payload> }
//   Failure: { "error": "<message>" }
// Derivation exports validate the source before producing output.

fn ok_json<T: Serialize>(payload: &T) -> String {
    serde_json::to_string(&serde_json::json!({ "ok": payload })).unwrap_or_default()
}

fn err_json(msg: &str) -> String {
    serde_json::to_string(&serde_json::json!({ "error": msg })).unwrap_or_default()
}

/// Parse and validate a CharacterSourceDef. Returns the def or an error string.
fn parse_and_validate(json: &str) -> Result<CharacterSourceDef, String> {
    let def: CharacterSourceDef = serde_json::from_str(json)
        .map_err(|e| format!("JSON parse error: {}", e))?;
    let errors = def.validate();
    if !errors.is_empty() {
        return Err(format!("Validation failed: {}", errors.join("; ")));
    }
    Ok(def)
}

// ── WASM exports ────────────────────────────────────────────────────────

/// Validate a CharacterSourceDef JSON string.
/// Returns: `{ "ok": { "valid": true, "errors": [] } }`
///      or: `{ "ok": { "valid": false, "errors": ["..."] } }`
#[wasm_bindgen]
pub fn validate_source(json: &str) -> String {
    let def: CharacterSourceDef = match serde_json::from_str(json) {
        Ok(d) => d,
        Err(e) => {
            return ok_json(&ValidationResult {
                valid: false,
                errors: vec![format!("JSON parse error: {}", e)],
            });
        }
    };

    let errors = def.validate();
    ok_json(&ValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}

#[derive(Serialize, Deserialize)]
struct ValidationResult {
    valid: bool,
    errors: Vec<String>,
}

/// Plan the atlas layout for a character.
/// Validates the source definition first — rejects invalid input.
/// Returns: `{ "ok": <AtlasPlan> }` or `{ "error": "..." }`
#[wasm_bindgen]
pub fn plan_atlas(source_json: &str) -> String {
    match parse_and_validate(source_json) {
        Err(e) => err_json(&e),
        Ok(def) => ok_json(&build_atlas_plan(&def)),
    }
}

/// Generate a CharacterBakedDef from a source definition.
/// Validates the source definition first — rejects invalid input.
/// Input: source JSON + atlas relative path (e.g., "characters/hotdogguy.png").
/// Returns: `{ "ok": <CharacterBakedDef> }` or `{ "error": "..." }`
#[wasm_bindgen]
pub fn generate_baked_def(source_json: &str, atlas_path: &str) -> String {
    let def = match parse_and_validate(source_json) {
        Err(e) => return err_json(&e),
        Ok(d) => d,
    };

    let plan = build_atlas_plan(&def);

    // Build baked animations: one entry per row, keyed by "{anim}_{dir}".
    // Row order must match build_atlas_plan's deterministic sort.
    let mut animations = std::collections::BTreeMap::new();
    let sorted_rows = sorted_anim_dir_rows(&def);

    for (row_idx, (anim, dir, frames, do_loop)) in sorted_rows.iter().enumerate() {
        let key = format!("{}_{}", anim, dir);
        animations.insert(
            key,
            BakedAnimation {
                row: row_idx as u32,
                frames: *frames,
                r#loop: *do_loop,
            },
        );
    }

    let baked = CharacterBakedDef {
        version: 1,
        id: def.id.clone(),
        name: def.name.clone(),
        atlas: atlas_path.to_string(),
        atlas_width: plan.width,
        atlas_height: plan.height,
        sprite_size: def.sprite_size,
        frame_duration: def.frame_duration,
        animations,
        weapon_def_id: def.weapon_def_id.clone(),
        throwable_def_id: def.throwable_def_id.clone(),
    };

    ok_json(&baked)
}

/// Generate sprite registry entries for assets_feathered.json.
/// Validates the source definition first — rejects invalid input.
/// Input: source JSON + atlas index (position in the atlases array).
/// Returns: `{ "ok": { "key": { atlas, col, row }, ... } }` or `{ "error": "..." }`
///
/// Produces two entry variants per animation+direction:
/// - `"{id}/{anim}_{dir}"` → first frame (shorthand)
/// - `"{id}/{anim}_{dir}/{frame}"` → each individual frame
#[wasm_bindgen]
pub fn generate_sprite_entries(source_json: &str, atlas_index: u32) -> String {
    let def = match parse_and_validate(source_json) {
        Err(e) => return err_json(&e),
        Ok(d) => d,
    };

    let plan = build_atlas_plan(&def);

    #[derive(Serialize)]
    struct SpriteEntry {
        atlas: u32,
        col: u32,
        row: u32,
    }

    let mut entries = std::collections::BTreeMap::new();
    let mut seen_anim_dir = std::collections::HashSet::new();

    for p in &plan.placements {
        let anim_dir_key = format!("{}/{}_{}", def.id, p.animation, p.direction);
        let frame_key = format!("{}/{}_{}/{}", def.id, p.animation, p.direction, p.frame);

        entries.insert(
            frame_key,
            SpriteEntry {
                atlas: atlas_index,
                col: p.col,
                row: p.row,
            },
        );

        if !seen_anim_dir.contains(&anim_dir_key) {
            entries.insert(
                anim_dir_key.clone(),
                SpriteEntry {
                    atlas: atlas_index,
                    col: p.col,
                    row: p.row,
                },
            );
            seen_anim_dir.insert(anim_dir_key);
        }
    }

    ok_json(&entries)
}

/// Collect all (anim, direction, frames, loop) rows in deterministic order.
/// Used by both build_atlas_plan and generate_baked_def to ensure row indices match.
fn sorted_anim_dir_rows(def: &CharacterSourceDef) -> Vec<(String, String, u32, bool)> {
    let mut rows = Vec::new();
    for (anim, dirs) in &def.animations {
        for &dir in DIRECTIONS {
            if let Some(df) = get_dir_frames(dirs, dir) {
                rows.push((anim.clone(), dir.to_string(), df.frames, df.r#loop));
            }
        }
    }
    rows.sort_by(|a, b| {
        let key_a = format!("{}_{}", a.0, a.1);
        let key_b = format!("{}_{}", b.0, b.1);
        key_a.cmp(&key_b)
    });
    rows
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_source_json() -> String {
        serde_json::to_string(&CharacterSourceDef {
            version: 1,
            id: "test_char".to_string(),
            name: "Test".to_string(),
            sprite_size: 128,
            frame_duration: 0.1,
            weapon_def_id: None,
            throwable_def_id: None,
            animations: {
                let mut m = std::collections::BTreeMap::new();
                m.insert(
                    "idle".to_string(),
                    AnimationDirections {
                        north: None,
                        east: None,
                        south: DirectionFrames {
                            frames: 1,
                            r#loop: true,
                        },
                        west: None,
                    },
                );
                m.insert(
                    "walk".to_string(),
                    AnimationDirections {
                        north: Some(DirectionFrames {
                            frames: 4,
                            r#loop: true,
                        }),
                        east: Some(DirectionFrames {
                            frames: 4,
                            r#loop: true,
                        }),
                        south: DirectionFrames {
                            frames: 4,
                            r#loop: true,
                        },
                        west: Some(DirectionFrames {
                            frames: 4,
                            r#loop: true,
                        }),
                    },
                );
                m
            },
            created_at: None,
            updated_at: None,
        })
        .unwrap()
    }

    /// Helper: unwrap the `{ "ok": <T> }` envelope from an export result.
    fn unwrap_ok<T: serde::de::DeserializeOwned>(result_json: &str) -> T {
        let envelope: serde_json::Value = serde_json::from_str(result_json)
            .unwrap_or_else(|e| panic!("invalid JSON from export: {}\n{}", e, result_json));
        assert!(envelope.get("ok").is_some(), "expected ok envelope, got: {}", result_json);
        serde_json::from_value(envelope["ok"].clone())
            .unwrap_or_else(|e| panic!("failed to parse ok payload: {}\n{}", e, result_json))
    }

    #[test]
    fn validate_valid_source() {
        let json = sample_source_json();
        let result: ValidationResult = unwrap_ok(&validate_source(&json));
        assert!(result.valid);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn validate_invalid_source() {
        let result: ValidationResult = unwrap_ok(
            &validate_source("{\"version\":1,\"id\":\"\",\"name\":\"\",\"spriteSize\":99,\"frameDuration\":0.1,\"animations\":{}}")
        );
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.contains("id is empty")));
        assert!(result.errors.iter().any(|e| e.contains("spriteSize")));
    }

    #[test]
    fn plan_atlas_layout() {
        let json = sample_source_json();
        let plan: AtlasPlan = unwrap_ok(&plan_atlas(&json));

        // idle_south (1) + walk_east (4) + walk_north (4) + walk_south (4) + walk_west (4) = 5 rows
        assert_eq!(plan.rows, 5);
        assert_eq!(plan.cols, 8);
        assert_eq!(plan.width, 1024);
        assert_eq!(plan.height, 640);
        // 1 + 4 + 4 + 4 + 4 = 17 placements
        assert_eq!(plan.placements.len(), 17);
    }

    #[test]
    fn plan_atlas_rejects_invalid() {
        let result = plan_atlas("{\"version\":1,\"id\":\"\",\"name\":\"\",\"spriteSize\":99,\"frameDuration\":0.1,\"animations\":{}}");
        let envelope: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(envelope.get("error").is_some(), "expected error, got: {}", result);
    }

    #[test]
    fn generate_baked_def_structure() {
        let json = sample_source_json();
        let baked: CharacterBakedDef = unwrap_ok(&generate_baked_def(&json, "characters/test_char.png"));

        assert_eq!(baked.id, "test_char");
        assert_eq!(baked.atlas, "characters/test_char.png");
        assert_eq!(baked.atlas_width, 1024);
        assert_eq!(baked.atlas_height, 640);
        assert!(baked.animations.contains_key("idle_south"));
        assert!(baked.animations.contains_key("walk_north"));
        assert_eq!(baked.animations["walk_south"].frames, 4);
    }

    #[test]
    fn generate_sprite_entries_keys() {
        let json = sample_source_json();
        let entries: std::collections::BTreeMap<String, serde_json::Value> =
            unwrap_ok(&generate_sprite_entries(&json, 5));

        // Shorthand + per-frame: idle_south (1+1) + walk_east (1+4) + walk_north (1+4) + walk_south (1+4) + walk_west (1+4) = 22
        assert_eq!(entries.len(), 22);
        assert!(entries.contains_key("test_char/idle_south"));
        assert!(entries.contains_key("test_char/idle_south/0"));
        assert!(entries.contains_key("test_char/walk_north/3"));

        let entry = entries["test_char/idle_south/0"].as_object().unwrap();
        assert_eq!(entry["atlas"], 5);
    }
}
