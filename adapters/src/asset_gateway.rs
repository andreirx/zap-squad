//! Asset Gateway - loads and converts assets to core DTOs
//!
//! Handles LDtk level loading with custom entity fields for CompositeActor spawning.

use glam::{IVec2, Vec2};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use zapsquad_core::{ActorId, CompositeActor, Level, ScriptId, Tile, TileId};

/// LDtk level format (simplified)
#[derive(Debug, Deserialize)]
pub struct LdtkProject {
    pub levels: Vec<LdtkLevel>,
}

#[derive(Debug, Deserialize)]
pub struct LdtkLevel {
    pub identifier: String,
    #[serde(rename = "pxWid")]
    pub width: u32,
    #[serde(rename = "pxHei")]
    pub height: u32,
    #[serde(rename = "layerInstances")]
    pub layers: Vec<LdtkLayer>,
}

#[derive(Debug, Deserialize)]
pub struct LdtkLayer {
    #[serde(rename = "__identifier")]
    pub identifier: String,
    #[serde(rename = "__type")]
    pub layer_type: String,
    #[serde(rename = "__gridSize")]
    pub grid_size: u32,
    #[serde(rename = "intGridCsv", default)]
    pub int_grid: Vec<i32>,
    #[serde(rename = "entityInstances", default)]
    pub entities: Vec<LdtkEntity>,
}

#[derive(Debug, Deserialize)]
pub struct LdtkEntity {
    #[serde(rename = "__identifier")]
    pub identifier: String,
    pub px: [i32; 2],
    #[serde(rename = "fieldInstances", default)]
    pub fields: Vec<LdtkFieldInstance>,
}

#[derive(Debug, Deserialize)]
pub struct LdtkFieldInstance {
    #[serde(rename = "__identifier")]
    pub identifier: String,
    #[serde(rename = "__value")]
    pub value: Value,
}

/// Parsed entity spawn info with custom fields
#[derive(Debug, Clone)]
pub struct EntitySpawnInfo {
    pub identifier: String,
    pub position: Vec2,
    pub body_def_id: Option<String>,
    pub weapon_def_id: Option<String>,
    pub script: Option<String>,
    pub tag: Option<String>,
    pub custom_fields: HashMap<String, Value>,
}

/// Asset gateway for loading game assets
pub struct AssetGateway;

impl AssetGateway {
    /// Parse LDtk JSON and convert to core Level
    pub fn load_ldtk_level(json: &str, level_name: &str) -> Result<Level, String> {
        let project: LdtkProject = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse LDtk: {}", e))?;

        let ldtk_level = project
            .levels
            .iter()
            .find(|l| l.identifier == level_name)
            .ok_or_else(|| format!("Level '{}' not found", level_name))?;

        // Find collision layer
        let collision_layer = ldtk_level
            .layers
            .iter()
            .find(|l| l.layer_type == "IntGrid");

        let grid_size = collision_layer.map(|l| l.grid_size).unwrap_or(32);
        let grid_width = ldtk_level.width / grid_size;
        let grid_height = ldtk_level.height / grid_size;

        let mut level = Level::new(level_name, grid_width, grid_height, grid_size);

        // Set collision tiles from IntGrid
        if let Some(col_layer) = collision_layer {
            for (idx, &value) in col_layer.int_grid.iter().enumerate() {
                let x = (idx as u32) % grid_width;
                let y = (idx as u32) / grid_width;
                let walkable = value == 0; // 0 = walkable, non-zero = blocked
                level.set_tile(
                    x,
                    y,
                    Tile {
                        id: TileId(value as u32),
                        walkable,
                    },
                );
            }
        }

        Ok(level)
    }

    /// Extract entity spawn points from LDtk level (simple version)
    pub fn get_entity_spawns(json: &str, level_name: &str) -> Result<Vec<(String, IVec2)>, String> {
        let project: LdtkProject = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse LDtk: {}", e))?;

        let ldtk_level = project
            .levels
            .iter()
            .find(|l| l.identifier == level_name)
            .ok_or_else(|| format!("Level '{}' not found", level_name))?;

        let mut spawns = Vec::new();

        for layer in &ldtk_level.layers {
            if layer.layer_type == "Entities" {
                for entity in &layer.entities {
                    spawns.push((
                        entity.identifier.clone(),
                        IVec2::new(entity.px[0], entity.px[1]),
                    ));
                }
            }
        }

        Ok(spawns)
    }

    /// Extract entity spawn info with custom fields from LDtk level
    ///
    /// Supports these custom fields on LDtk entities:
    /// - `body_def_id` (String) - References character definition
    /// - `weapon_def_id` (String) - References weapon definition
    /// - `script` (String) - Rhai script name
    /// - `tag` (String) - For find_nearest queries
    pub fn get_entity_spawn_info(
        json: &str,
        level_name: &str,
    ) -> Result<Vec<EntitySpawnInfo>, String> {
        let project: LdtkProject = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse LDtk: {}", e))?;

        let ldtk_level = project
            .levels
            .iter()
            .find(|l| l.identifier == level_name)
            .ok_or_else(|| format!("Level '{}' not found", level_name))?;

        let mut spawns = Vec::new();

        for layer in &ldtk_level.layers {
            if layer.layer_type == "Entities" {
                for entity in &layer.entities {
                    let mut info = EntitySpawnInfo {
                        identifier: entity.identifier.clone(),
                        position: Vec2::new(entity.px[0] as f32, entity.px[1] as f32),
                        body_def_id: None,
                        weapon_def_id: None,
                        script: None,
                        tag: None,
                        custom_fields: HashMap::new(),
                    };

                    // Parse custom fields
                    for field in &entity.fields {
                        match field.identifier.as_str() {
                            "body_def_id" | "bodyDefId" => {
                                info.body_def_id = field.value.as_str().map(String::from);
                            }
                            "weapon_def_id" | "weaponDefId" => {
                                info.weapon_def_id = field.value.as_str().map(String::from);
                            }
                            "script" => {
                                info.script = field.value.as_str().map(String::from);
                            }
                            "tag" => {
                                info.tag = field.value.as_str().map(String::from);
                            }
                            _ => {
                                // Store other custom fields
                                info.custom_fields
                                    .insert(field.identifier.clone(), field.value.clone());
                            }
                        }
                    }

                    // Use entity identifier as fallback for body_def_id and tag
                    if info.body_def_id.is_none() {
                        info.body_def_id = Some(entity.identifier.to_lowercase());
                    }
                    if info.tag.is_none() {
                        info.tag = Some(entity.identifier.to_lowercase());
                    }

                    spawns.push(info);
                }
            }
        }

        Ok(spawns)
    }

    /// Load LDtk level and create CompositeActors for all entities
    ///
    /// This is the main method for loading a complete level with actors.
    /// It parses entity custom fields and creates properly configured CompositeActors.
    pub fn load_level_actors(
        json: &str,
        level_name: &str,
        script_map: &HashMap<String, ScriptId>,
        next_actor_id: &mut u32,
    ) -> Result<(Level, Vec<CompositeActor>), String> {
        // Load the base level
        let level = Self::load_ldtk_level(json, level_name)?;

        // Get entity spawn info
        let spawn_info = Self::get_entity_spawn_info(json, level_name)?;

        // Create CompositeActors
        let mut actors = Vec::new();

        for info in spawn_info {
            let id = ActorId(*next_actor_id);
            *next_actor_id += 1;

            let body_def_id = info.body_def_id.unwrap_or_else(|| "default".to_string());
            let tag = info.tag.unwrap_or_else(|| "entity".to_string());

            let mut actor = CompositeActor::new(id, info.position, &body_def_id).with_tag(&tag);

            // Set weapon if specified
            if let Some(weapon_id) = &info.weapon_def_id {
                actor = actor.with_weapon(weapon_id);
            }

            // Set script if specified and exists in script_map
            if let Some(script_name) = &info.script {
                if let Some(&script_id) = script_map.get(script_name) {
                    actor.script_id = Some(script_id);
                }
            }

            // Extract health from custom fields if present
            if let Some(Value::Number(n)) = info.custom_fields.get("health") {
                if let Some(health) = n.as_i64() {
                    actor.max_health = health as i32;
                    actor.health = health as i32;
                }
            }
            if let Some(Value::Number(n)) = info.custom_fields.get("max_health") {
                if let Some(max_health) = n.as_i64() {
                    actor.max_health = max_health as i32;
                }
            }

            actors.push(actor);
        }

        Ok((level, actors))
    }

    /// Get list of level names in an LDtk project
    pub fn list_levels(json: &str) -> Result<Vec<String>, String> {
        let project: LdtkProject = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse LDtk: {}", e))?;

        Ok(project.levels.iter().map(|l| l.identifier.clone()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LDTK: &str = r#"{
        "levels": [{
            "identifier": "Level_0",
            "pxWid": 160,
            "pxHei": 160,
            "layerInstances": [
                {
                    "__identifier": "Collision",
                    "__type": "IntGrid",
                    "__gridSize": 32,
                    "intGridCsv": [0,0,0,0,0, 0,0,0,0,0, 0,0,1,0,0, 0,0,0,0,0, 0,0,0,0,0]
                },
                {
                    "__identifier": "Entities",
                    "__type": "Entities",
                    "__gridSize": 32,
                    "entityInstances": [
                        { "__identifier": "Player", "px": [32, 32] },
                        { "__identifier": "Enemy", "px": [128, 64] }
                    ]
                }
            ]
        }]
    }"#;

    const SAMPLE_LDTK_WITH_FIELDS: &str = r#"{
        "levels": [{
            "identifier": "Level_0",
            "pxWid": 320,
            "pxHei": 240,
            "layerInstances": [
                {
                    "__identifier": "Collision",
                    "__type": "IntGrid",
                    "__gridSize": 32,
                    "intGridCsv": [0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0]
                },
                {
                    "__identifier": "Entities",
                    "__type": "Entities",
                    "__gridSize": 32,
                    "entityInstances": [
                        {
                            "__identifier": "Soldier",
                            "px": [64, 64],
                            "fieldInstances": [
                                { "__identifier": "body_def_id", "__value": "soldier_heavy" },
                                { "__identifier": "weapon_def_id", "__value": "rifle" },
                                { "__identifier": "script", "__value": "player_input" },
                                { "__identifier": "tag", "__value": "player" },
                                { "__identifier": "health", "__value": 100 }
                            ]
                        },
                        {
                            "__identifier": "Alien",
                            "px": [256, 128],
                            "fieldInstances": [
                                { "__identifier": "bodyDefId", "__value": "alien_grunt" },
                                { "__identifier": "tag", "__value": "enemy" },
                                { "__identifier": "script", "__value": "patrol_ai" }
                            ]
                        }
                    ]
                }
            ]
        }]
    }"#;

    #[test]
    fn load_ldtk_level() {
        let level = AssetGateway::load_ldtk_level(SAMPLE_LDTK, "Level_0").unwrap();
        assert_eq!(level.width, 5);
        assert_eq!(level.height, 5);
        assert_eq!(level.tile_size, 32);

        // Check collision at (2, 2)
        assert!(!level.is_walkable(2, 2));
        assert!(level.is_walkable(0, 0));
    }

    #[test]
    fn get_entity_spawns() {
        let spawns = AssetGateway::get_entity_spawns(SAMPLE_LDTK, "Level_0").unwrap();
        assert_eq!(spawns.len(), 2);
        assert_eq!(spawns[0].0, "Player");
        assert_eq!(spawns[0].1, IVec2::new(32, 32));
    }

    #[test]
    fn get_entity_spawn_info_with_custom_fields() {
        let spawns =
            AssetGateway::get_entity_spawn_info(SAMPLE_LDTK_WITH_FIELDS, "Level_0").unwrap();
        assert_eq!(spawns.len(), 2);

        // Check first entity (Soldier with full custom fields)
        let soldier = &spawns[0];
        assert_eq!(soldier.identifier, "Soldier");
        assert_eq!(soldier.position, Vec2::new(64.0, 64.0));
        assert_eq!(soldier.body_def_id, Some("soldier_heavy".to_string()));
        assert_eq!(soldier.weapon_def_id, Some("rifle".to_string()));
        assert_eq!(soldier.script, Some("player_input".to_string()));
        assert_eq!(soldier.tag, Some("player".to_string()));
        assert_eq!(
            soldier.custom_fields.get("health"),
            Some(&Value::Number(100.into()))
        );

        // Check second entity (Alien with camelCase field names)
        let alien = &spawns[1];
        assert_eq!(alien.identifier, "Alien");
        assert_eq!(alien.position, Vec2::new(256.0, 128.0));
        assert_eq!(alien.body_def_id, Some("alien_grunt".to_string()));
        assert_eq!(alien.weapon_def_id, None);
        assert_eq!(alien.script, Some("patrol_ai".to_string()));
        assert_eq!(alien.tag, Some("enemy".to_string()));
    }

    #[test]
    fn get_entity_spawn_info_fallback_defaults() {
        let spawns = AssetGateway::get_entity_spawn_info(SAMPLE_LDTK, "Level_0").unwrap();
        assert_eq!(spawns.len(), 2);

        // Without custom fields, should use identifier as fallback
        let player = &spawns[0];
        assert_eq!(player.identifier, "Player");
        assert_eq!(player.body_def_id, Some("player".to_string())); // lowercase identifier
        assert_eq!(player.tag, Some("player".to_string())); // lowercase identifier
        assert_eq!(player.weapon_def_id, None);
        assert_eq!(player.script, None);
    }

    #[test]
    fn load_level_actors() {
        let mut script_map = HashMap::new();
        script_map.insert("player_input".to_string(), ScriptId(1));
        script_map.insert("patrol_ai".to_string(), ScriptId(2));

        let mut next_id = 1;
        let (level, actors) = AssetGateway::load_level_actors(
            SAMPLE_LDTK_WITH_FIELDS,
            "Level_0",
            &script_map,
            &mut next_id,
        )
        .unwrap();

        assert_eq!(level.width, 10);
        assert_eq!(level.height, 7);
        assert_eq!(actors.len(), 2);

        // Check soldier actor
        let soldier = &actors[0];
        assert_eq!(soldier.position, Vec2::new(64.0, 64.0));
        assert_eq!(soldier.body_def_id, "soldier_heavy");
        assert_eq!(soldier.weapon_def_id, Some("rifle".to_string()));
        assert_eq!(soldier.script_id, Some(ScriptId(1)));
        assert_eq!(soldier.tag, "player");
        assert_eq!(soldier.health, 100);
        assert_eq!(soldier.max_health, 100);

        // Check alien actor
        let alien = &actors[1];
        assert_eq!(alien.position, Vec2::new(256.0, 128.0));
        assert_eq!(alien.body_def_id, "alien_grunt");
        assert_eq!(alien.weapon_def_id, None);
        assert_eq!(alien.script_id, Some(ScriptId(2)));
        assert_eq!(alien.tag, "enemy");
    }

    #[test]
    fn list_levels() {
        let levels = AssetGateway::list_levels(SAMPLE_LDTK).unwrap();
        assert_eq!(levels, vec!["Level_0"]);
    }
}
