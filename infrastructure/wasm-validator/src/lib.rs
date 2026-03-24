//! WASM validation adapter for game definitions.
//!
//! Exposes `validate_game_json(json) -> json` through a minimal DTO boundary.
//! The Rules Editor loads this module to validate GameDefinition JSON
//! without pulling in the full game/rendering runtime.
//!
//! Architecture:
//!   core/entities/game_rules/validation.rs  — owns validate_game()
//!   infrastructure/wasm-validator/          — THIS: WASM adapter, DTO mapping
//!   ui/web/src/editors/RulesEditor/         — consumes DTO JSON, displays issues
//!
//! Dependency: wasm-validator -> core (inward only). No adapters, no zap-engine.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use zapsquad_core::entities::game_rules::{GameDefinition, IssueSeverity, validate_game};

// ── DTO types (never cross inward) ──────────────────────────────────

/// A single validation issue for the UI.
#[derive(Serialize)]
struct ValidationIssueDto {
    /// "error" or "warning"
    severity: &'static str,
    message: String,
}

/// Complete validation result for the UI.
#[derive(Serialize)]
struct ValidationResultDto {
    /// Whether the game can be started (no errors).
    playable: bool,
    /// All issues found, errors and warnings.
    issues: Vec<ValidationIssueDto>,
}

// ── WASM exports ────────────────────────────────────────────────────

/// Initialize panic hook for better browser error messages.
#[wasm_bindgen]
pub fn init_validator() {
    console_error_panic_hook::set_once();
}

/// Validate a GameDefinition JSON string.
///
/// Input: JSON string matching core/entities/game_rules/definition.rs GameDefinition.
/// Output: JSON string matching ValidationResultDto { playable, issues[] }.
///
/// Parse errors are returned as validation issues (severity: "error"), not panics.
/// This function never panics on malformed input.
#[wasm_bindgen]
pub fn validate_game_json(json: &str) -> String {
    // Phase 1: Parse JSON into GameDefinition
    let def: GameDefinition = match serde_json::from_str(json) {
        Ok(d) => d,
        Err(e) => {
            // Return parse error as a validation issue, not a panic
            let result = ValidationResultDto {
                playable: false,
                issues: vec![ValidationIssueDto {
                    severity: "error",
                    message: format!("Failed to parse game definition: {}", e),
                }],
            };
            // serde_json::to_string on our own DTO cannot fail
            return serde_json::to_string(&result).unwrap();
        }
    };

    // Phase 2: Run core validation
    let result = validate_game(&def);

    // Phase 3: Map to DTO
    let dto = ValidationResultDto {
        playable: result.is_playable(),
        issues: result
            .issues
            .iter()
            .map(|i| ValidationIssueDto {
                severity: match i.severity {
                    IssueSeverity::Error => "error",
                    IssueSeverity::Warning => "warning",
                },
                message: i.message.clone(),
            })
            .collect(),
    };

    serde_json::to_string(&dto).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_json_returns_parse_error() {
        let result_json = validate_game_json("not valid json");
        let dto: serde_json::Value = serde_json::from_str(&result_json).unwrap();
        assert_eq!(dto["playable"], false);
        assert_eq!(dto["issues"][0]["severity"], "error");
        assert!(dto["issues"][0]["message"]
            .as_str()
            .unwrap()
            .contains("Failed to parse"));
    }

    #[test]
    fn empty_game_returns_errors() {
        let json = serde_json::json!({
            "name": "Empty",
            "description": "",
            "mode": "RealTime",
            "teams": [],
            "stat_schema": { "stats": [] },
            "resource_schema": { "resources": [] },
            "character_templates": [],
            "win_conditions": [],
            "rules_script": "",
            "world_gen_script": null,
            "world_binding": { "zones": [], "wave_paths": [], "world_name": null }
        });
        let result_json = validate_game_json(&json.to_string());
        let dto: serde_json::Value = serde_json::from_str(&result_json).unwrap();
        assert_eq!(dto["playable"], false);
        let issues = dto["issues"].as_array().unwrap();
        assert!(issues.iter().any(|i| i["severity"] == "error"));
    }

    #[test]
    fn valid_game_returns_playable() {
        let json = serde_json::json!({
            "name": "Valid",
            "description": "test",
            "mode": "RealTime",
            "teams": [
                { "id": 0, "name": "A", "controller": "Human", "color": "#fff" },
                { "id": 1, "name": "B", "controller": { "Cpu": { "script_name": "ai" } }, "color": "#000" }
            ],
            "stat_schema": {
                "stats": [
                    { "key": "hp", "display_name": "HP", "default_value": 100.0,
                      "min_value": 0.0, "max_value": 999.0, "visible": true, "visible_to_enemies": false }
                ]
            },
            "resource_schema": { "resources": [] },
            "character_templates": [],
            "win_conditions": ["Elimination"],
            "rules_script": "default_rules",
            "world_gen_script": null,
            "world_binding": { "zones": [], "wave_paths": [], "world_name": null }
        });
        let result_json = validate_game_json(&json.to_string());
        let dto: serde_json::Value = serde_json::from_str(&result_json).unwrap();
        assert_eq!(dto["playable"], true);
    }

    #[test]
    fn unknown_enum_variant_returns_parse_error() {
        let json = serde_json::json!({
            "name": "Bad Mode",
            "description": "",
            "mode": "FreeForAll",
            "teams": [],
            "stat_schema": { "stats": [] },
            "resource_schema": { "resources": [] },
            "character_templates": [],
            "win_conditions": [],
            "rules_script": "",
            "world_gen_script": null,
            "world_binding": { "zones": [], "wave_paths": [], "world_name": null }
        });
        let result_json = validate_game_json(&json.to_string());
        let dto: serde_json::Value = serde_json::from_str(&result_json).unwrap();
        assert_eq!(dto["playable"], false);
        assert!(dto["issues"][0]["message"]
            .as_str()
            .unwrap()
            .contains("Failed to parse"));
    }
}
