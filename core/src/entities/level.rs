//! Level entity - tile-based level data

use serde::{Deserialize, Serialize};

/// Unique identifier for a tile type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileId(pub u32);

/// A single tile in the level
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Tile {
    pub id: TileId,
    pub walkable: bool,
}

impl Default for Tile {
    fn default() -> Self {
        Self {
            id: TileId(0),
            walkable: true,
        }
    }
}

/// A level with tile-based layout
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    tiles: Vec<Tile>,
}

impl Level {
    pub fn new(name: impl Into<String>, width: u32, height: u32, tile_size: u32) -> Self {
        let tile_count = (width * height) as usize;
        Self {
            name: name.into(),
            width,
            height,
            tile_size,
            tiles: vec![Tile::default(); tile_count],
        }
    }

    /// Get tile at grid position
    pub fn get_tile(&self, x: u32, y: u32) -> Option<&Tile> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let idx = (y * self.width + x) as usize;
        self.tiles.get(idx)
    }

    /// Set tile at grid position
    pub fn set_tile(&mut self, x: u32, y: u32, tile: Tile) {
        if x >= self.width || y >= self.height {
            return;
        }
        let idx = (y * self.width + x) as usize;
        if idx < self.tiles.len() {
            self.tiles[idx] = tile;
        }
    }

    /// Check if a grid position is walkable
    pub fn is_walkable(&self, x: u32, y: u32) -> bool {
        self.get_tile(x, y).map(|t| t.walkable).unwrap_or(false)
    }

    /// Convert world position to grid position
    pub fn world_to_grid(&self, world_x: f32, world_y: f32) -> (u32, u32) {
        let gx = (world_x / self.tile_size as f32).floor() as u32;
        let gy = (world_y / self.tile_size as f32).floor() as u32;
        (gx.min(self.width.saturating_sub(1)), gy.min(self.height.saturating_sub(1)))
    }

    /// Convert grid position to world center
    pub fn grid_to_world(&self, grid_x: u32, grid_y: u32) -> (f32, f32) {
        let half = self.tile_size as f32 / 2.0;
        let wx = grid_x as f32 * self.tile_size as f32 + half;
        let wy = grid_y as f32 * self.tile_size as f32 + half;
        (wx, wy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_creation() {
        let level = Level::new("test", 10, 8, 32);
        assert_eq!(level.width, 10);
        assert_eq!(level.height, 8);
        assert_eq!(level.tile_size, 32);
    }

    #[test]
    fn tile_access() {
        let mut level = Level::new("test", 10, 8, 32);
        level.set_tile(5, 3, Tile { id: TileId(1), walkable: false });

        assert!(level.get_tile(0, 0).unwrap().walkable);
        assert!(!level.get_tile(5, 3).unwrap().walkable);
        assert!(level.get_tile(100, 100).is_none());
    }

    #[test]
    fn coordinate_conversion() {
        let level = Level::new("test", 10, 10, 32);

        // World to grid
        assert_eq!(level.world_to_grid(0.0, 0.0), (0, 0));
        assert_eq!(level.world_to_grid(32.0, 64.0), (1, 2));
        assert_eq!(level.world_to_grid(48.0, 48.0), (1, 1));

        // Grid to world (center of tile)
        assert_eq!(level.grid_to_world(0, 0), (16.0, 16.0));
        assert_eq!(level.grid_to_world(1, 2), (48.0, 80.0));
    }
}
