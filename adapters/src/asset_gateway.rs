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
    #[serde(rename = "gridTiles", default)]
    pub grid_tiles: Vec<LdtkGridTile>,
}

/// Grid tile from LDtk Tiles layer
#[derive(Debug, Deserialize, Clone)]
pub struct LdtkGridTile {
    /// Position in pixels [x, y]
    pub px: [i32; 2],
    /// Tile asset source ID
    pub src: String,
    /// Tile variation/connectivity index (nullable - defaults to 0)
    #[serde(default)]
    pub t: Option<u32>,
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
                // LDtk entity positions are already center-based (default pivot is 0.5, 0.5)
                // so use px values directly without offset
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

    /// Extract grid tiles from level (terrain, paths, etc.)
    ///
    /// DEPRECATED: Use get_tiles_with_manifest for proper sprite index calculation.
    /// This version passes the raw seed as variation, which is incorrect.
    pub fn get_tiles(json: &str, level_name: &str) -> Result<Vec<TileInstance>, String> {
        // Default tile definitions - fallback when no manifest provided
        let empty_defs: HashMap<String, TileDefinition> = HashMap::new();
        Self::get_tiles_with_manifest(json, level_name, &empty_defs)
    }

    /// Extract grid tiles from level with proper sprite index calculation.
    ///
    /// This method replicates the MapEditor's rendering logic:
    /// - Terrain tiles: sprite_index = getVariationFromSeed(seed, variations)
    /// - Path tiles (connectivity-based): sprite_index = bitmask - 1 (0-14)
    ///
    /// The tile_defs map should contain TileDefinition for each tile asset.
    pub fn get_tiles_with_manifest(
        json: &str,
        level_name: &str,
        tile_defs: &HashMap<String, TileDefinition>,
    ) -> Result<Vec<TileInstance>, String> {
        let project: LdtkProject = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse LDtk: {}", e))?;

        let ldtk_level = project
            .levels
            .iter()
            .find(|l| l.identifier == level_name)
            .ok_or_else(|| format!("Level '{}' not found", level_name))?;

        // Collect all grid tiles from Tiles layers
        let mut all_grid_tiles: Vec<&LdtkGridTile> = Vec::new();
        let mut grid_size = 128u32;

        for layer in &ldtk_level.layers {
            if layer.layer_type == "Tiles" || layer.identifier == "Tiles" || layer.identifier == "Terrain" {
                grid_size = layer.grid_size;
                for grid_tile in &layer.grid_tiles {
                    all_grid_tiles.push(grid_tile);
                }
            }
        }

        // Helper to check terrain type
        let get_terrain_type = |asset_id: &str| -> Option<&str> {
            tile_defs.get(asset_id).and_then(|d| d.terrain_type.as_deref())
        };

        // Build SEPARATE position grids for water paths vs ground paths
        // This handles overlapping tiles (e.g., river AND dirt_40px at same position)
        let mut water_path_grid: HashMap<(i32, i32), &LdtkGridTile> = HashMap::new();
        let mut ground_path_grid: HashMap<(i32, i32), &LdtkGridTile> = HashMap::new();
        let mut terrain_grid: HashMap<(i32, i32), &LdtkGridTile> = HashMap::new();

        for grid_tile in &all_grid_tiles {
            let key = (grid_tile.px[0], grid_tile.px[1]);
            let tile_def = tile_defs.get(&grid_tile.src);
            let tile_type = tile_def.and_then(|d| d.tile_type.as_deref());
            let terrain_type = tile_def.and_then(|d| d.terrain_type.as_deref());

            match tile_type {
                Some("PATH") | Some("BRIDGE") => {
                    if terrain_type == Some("WATER") {
                        water_path_grid.insert(key, *grid_tile);
                    } else {
                        ground_path_grid.insert(key, *grid_tile);
                    }
                }
                _ => {
                    terrain_grid.insert(key, *grid_tile);
                }
            }
        }

        // Determine which tiles are paths (15 variations = connectivity-based)
        let is_path_tile = |asset_id: &str| -> bool {
            if let Some(def) = tile_defs.get(asset_id) {
                def.variations >= 15 || def.tile_type.as_deref() == Some("PATH") || def.tile_type.as_deref() == Some("BRIDGE")
            } else {
                false
            }
        };

        // Process tiles with proper sprite index calculation
        let mut tiles = Vec::new();

        for grid_tile in &all_grid_tiles {
            let asset_id = &grid_tile.src;
            let seed = grid_tile.t.unwrap_or(0);
            let x = grid_tile.px[0];
            let y = grid_tile.px[1];

            let sprite_index = if is_path_tile(asset_id) {
                // Use the appropriate grid for connectivity calculation
                let terrain_type = get_terrain_type(asset_id);
                let path_grid = if terrain_type == Some("WATER") {
                    &water_path_grid
                } else {
                    &ground_path_grid
                };
                calculate_path_connectivity(x, y, grid_size as i32, asset_id, path_grid)
            } else {
                // Terrain tiles use seeded variation
                let variations = tile_defs.get(asset_id).map(|d| d.variations).unwrap_or(1);
                get_variation_from_seed(seed, variations)
            };

            let tile_def = tile_defs.get(asset_id);
            let tile_type = tile_def.and_then(|d| d.tile_type.clone());
            let terrain_type = tile_def.and_then(|d| d.terrain_type.clone());
            let bridge_asset_id = tile_def.and_then(|d| d.bridge_asset_id.clone());

            tiles.push(TileInstance {
                position: Vec2::new(x as f32, y as f32),
                asset_id: asset_id.clone(),
                sprite_index,
                size: grid_size as f32,
                tile_type,
                terrain_type,
                bridge_asset_id,
            });
        }

        Ok(tiles)
    }

    /// Parse tile definitions from manifest.json
    pub fn parse_tile_manifest(json: &str) -> Result<HashMap<String, TileDefinition>, String> {
        #[derive(Deserialize)]
        struct Manifest {
            #[serde(default)]
            tiles: HashMap<String, TileDefinition>,
        }

        let manifest: Manifest = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse manifest: {}", e))?;

        Ok(manifest.tiles)
    }
}

/// A tile instance in the level
#[derive(Debug, Clone)]
pub struct TileInstance {
    /// World position (top-left corner)
    pub position: Vec2,
    /// Tile asset ID (e.g., "ocean", "grass")
    pub asset_id: String,
    /// Computed sprite index (row * cols + col in the atlas grid)
    pub sprite_index: u32,
    /// Tile size in pixels
    pub size: f32,
    /// Tile type for layer assignment (e.g., "PATH", "BRIDGE", "TERRAIN")
    pub tile_type: Option<String>,
    /// Terrain type (e.g., "LAND", "WATER")
    pub terrain_type: Option<String>,
    /// Bridge asset ID for auto-bridge generation when path crosses water
    pub bridge_asset_id: Option<String>,
}

/// Tile definition from manifest.json
#[derive(Debug, Clone, Deserialize)]
pub struct TileDefinition {
    pub id: String,
    #[serde(default)]
    pub variations: u32,
    #[serde(rename = "tileType", default)]
    pub tile_type: Option<String>,
    #[serde(rename = "terrainType", default)]
    pub terrain_type: Option<String>,
    #[serde(rename = "bridgeAssetId", default)]
    pub bridge_asset_id: Option<String>,
    #[serde(rename = "atlasWidth", default)]
    pub atlas_width: u32,
    #[serde(rename = "spriteSize", default = "default_sprite_size")]
    pub sprite_size: u32,
}

fn default_sprite_size() -> u32 { 128 }

/// Replicate the MapEditor's getVariationFromSeed function
/// Returns deterministic pseudo-random variation based on seed
fn get_variation_from_seed(seed: u32, variations: u32) -> u32 {
    if variations <= 1 {
        return 0;
    }
    // Same algorithm as TypeScript: Math.sin(seed * 9999) * 10000 → fractional part → scale
    let x = (seed as f64 * 9999.0).sin() * 10000.0;
    let rand = x - x.floor();
    (rand * variations as f64).floor() as u32
}

/// Calculate path connectivity variation (0-14) based on neighboring paths
/// Bitmask: N=8, S=4, W=2, E=1
fn calculate_path_connectivity(
    x: i32,
    y: i32,
    grid_size: i32,
    asset_id: &str,
    path_grid: &HashMap<(i32, i32), &LdtkGridTile>,
) -> u32 {
    let mut bits = 0u32;

    // Check North (y - grid_size)
    if let Some(neighbor) = path_grid.get(&(x, y - grid_size)) {
        if neighbor.src == asset_id {
            bits |= 8;
        }
    }
    // Check South (y + grid_size)
    if let Some(neighbor) = path_grid.get(&(x, y + grid_size)) {
        if neighbor.src == asset_id {
            bits |= 4;
        }
    }
    // Check West (x - grid_size)
    if let Some(neighbor) = path_grid.get(&(x - grid_size, y)) {
        if neighbor.src == asset_id {
            bits |= 2;
        }
    }
    // Check East (x + grid_size)
    if let Some(neighbor) = path_grid.get(&(x + grid_size, y)) {
        if neighbor.src == asset_id {
            bits |= 1;
        }
    }

    if bits == 0 { 0 } else { bits - 1 }
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
        // LDtk entity positions are center-based, used directly
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
        // LDtk entity positions are center-based, used directly
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
