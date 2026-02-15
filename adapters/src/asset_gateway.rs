//! Asset Gateway - loads and converts assets to core DTOs

use glam::IVec2;
use serde::Deserialize;
use zapsquad_core::{Level, Tile, TileId};

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
}

/// Asset gateway for loading game assets
pub struct AssetGateway;

impl AssetGateway {
    /// Parse LDtk JSON and convert to core Level
    pub fn load_ldtk_level(json: &str, level_name: &str) -> Result<Level, String> {
        let project: LdtkProject = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse LDtk: {}", e))?;

        let ldtk_level = project.levels.iter()
            .find(|l| l.identifier == level_name)
            .ok_or_else(|| format!("Level '{}' not found", level_name))?;

        // Find collision layer
        let collision_layer = ldtk_level.layers.iter()
            .find(|l| l.layer_type == "IntGrid");

        let grid_size = collision_layer.map(|l| l.grid_size).unwrap_or(32);
        let grid_width = ldtk_level.width / grid_size;
        let grid_height = ldtk_level.height / grid_size;

        let mut level = Level::new(
            level_name,
            grid_width,
            grid_height,
            grid_size,
        );

        // Set collision tiles from IntGrid
        if let Some(col_layer) = collision_layer {
            for (idx, &value) in col_layer.int_grid.iter().enumerate() {
                let x = (idx as u32) % grid_width;
                let y = (idx as u32) / grid_width;
                let walkable = value == 0; // 0 = walkable, non-zero = blocked
                level.set_tile(x, y, Tile {
                    id: TileId(value as u32),
                    walkable,
                });
            }
        }

        Ok(level)
    }

    /// Extract entity spawn points from LDtk level
    pub fn get_entity_spawns(json: &str, level_name: &str) -> Result<Vec<(String, IVec2)>, String> {
        let project: LdtkProject = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse LDtk: {}", e))?;

        let ldtk_level = project.levels.iter()
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
}
