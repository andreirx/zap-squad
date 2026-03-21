//! Coordinate types for the infinite sparse tile grid.
//!
//! Two coordinate spaces exist:
//! - **Tile coordinates** (`TileCoord`): individual cell positions on the infinite grid.
//!   Each tile occupies exactly 1x1 world units. Tile (3, 7) spans world space (3.0, 7.0) to (4.0, 8.0).
//! - **Chunk coordinates** (`ChunkCoord`): 32x32 tile blocks used as the storage unit.
//!   Chunk (0, 0) contains tiles (0,0) through (31,31).
//!
//! Negative coordinates are fully supported. Division uses `div_euclid` to ensure
//! correct mapping for negative tile coords (e.g., tile (-1, 0) maps to chunk (-1, 0), local (31, 0)).

use serde::{Deserialize, Serialize};

/// Number of tiles along each axis of a chunk.
pub const CHUNK_SIZE: i32 = 32;

/// Total cells in one chunk (CHUNK_SIZE^2).
pub const CHUNK_AREA: usize = (CHUNK_SIZE * CHUNK_SIZE) as usize;

/// Maximum number of tile layers per cell.
///
/// Each cell can hold up to MAX_LAYERS tiles stacked vertically, indexed by
/// `TilePlacement.layer`. Memory per chunk: 8 bytes × MAX_LAYERS × CHUNK_AREA.
///
/// | MAX_LAYERS | Chunk size | L1 fit (32KB x86) | L1 fit (64KB+ Apple Silicon) |
/// |------------|------------|-------------------|-------------------------------|
/// | 1          | 8 KB       | yes               | yes                           |
/// | 4          | 32 KB      | edge              | yes                           |
/// | 8          | 64 KB      | no                | yes                           |
pub const MAX_LAYERS: usize = 8;

/// Position of a single tile on the infinite grid.
///
/// World-space mapping: tile (x, y) occupies the rectangle
/// `[x as f32, (x+1) as f32) x [y as f32, (y+1) as f32)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileCoord {
    pub x: i32,
    pub y: i32,
}

/// Position of a 32x32 chunk in the chunk grid.
///
/// Chunk (cx, cy) contains tiles from `(cx*32, cy*32)` to `(cx*32+31, cy*32+31)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChunkCoord {
    pub x: i32,
    pub y: i32,
}

impl TileCoord {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    /// Which chunk contains this tile.
    ///
    /// Uses Euclidean division so negative coordinates map correctly:
    /// - tile (-1, 0) -> chunk (-1, 0)
    /// - tile (-32, 0) -> chunk (-1, 0)
    /// - tile (-33, 0) -> chunk (-2, 0)
    pub fn chunk(self) -> ChunkCoord {
        ChunkCoord {
            x: self.x.div_euclid(CHUNK_SIZE),
            y: self.y.div_euclid(CHUNK_SIZE),
        }
    }

    /// Position within the containing chunk (0..31 on each axis).
    ///
    /// Uses Euclidean remainder so negative coordinates wrap correctly:
    /// - tile (-1, 0) -> local (31, 0)
    /// - tile (-32, 0) -> local (0, 0)
    pub fn local(self) -> (usize, usize) {
        (
            self.x.rem_euclid(CHUNK_SIZE) as usize,
            self.y.rem_euclid(CHUNK_SIZE) as usize,
        )
    }
}

impl ChunkCoord {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    /// World-space tile coordinate of this chunk's origin (top-left corner).
    pub fn origin_tile(self) -> TileCoord {
        TileCoord {
            x: self.x * CHUNK_SIZE,
            y: self.y * CHUNK_SIZE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positive_tile_to_chunk() {
        assert_eq!(TileCoord::new(0, 0).chunk(), ChunkCoord::new(0, 0));
        assert_eq!(TileCoord::new(31, 31).chunk(), ChunkCoord::new(0, 0));
        assert_eq!(TileCoord::new(32, 0).chunk(), ChunkCoord::new(1, 0));
        assert_eq!(TileCoord::new(63, 63).chunk(), ChunkCoord::new(1, 1));
        assert_eq!(TileCoord::new(100, 200).chunk(), ChunkCoord::new(3, 6));
    }

    #[test]
    fn negative_tile_to_chunk() {
        assert_eq!(TileCoord::new(-1, 0).chunk(), ChunkCoord::new(-1, 0));
        assert_eq!(TileCoord::new(-32, 0).chunk(), ChunkCoord::new(-1, 0));
        assert_eq!(TileCoord::new(-33, 0).chunk(), ChunkCoord::new(-2, 0));
        assert_eq!(TileCoord::new(-1, -1).chunk(), ChunkCoord::new(-1, -1));
    }

    #[test]
    fn positive_tile_to_local() {
        assert_eq!(TileCoord::new(0, 0).local(), (0, 0));
        assert_eq!(TileCoord::new(31, 31).local(), (31, 31));
        assert_eq!(TileCoord::new(32, 0).local(), (0, 0));
        assert_eq!(TileCoord::new(33, 1).local(), (1, 1));
    }

    #[test]
    fn negative_tile_to_local() {
        assert_eq!(TileCoord::new(-1, 0).local(), (31, 0));
        assert_eq!(TileCoord::new(-32, 0).local(), (0, 0));
        assert_eq!(TileCoord::new(-33, 0).local(), (31, 0));
        assert_eq!(TileCoord::new(-1, -1).local(), (31, 31));
    }

    #[test]
    fn chunk_origin_tile() {
        assert_eq!(ChunkCoord::new(0, 0).origin_tile(), TileCoord::new(0, 0));
        assert_eq!(ChunkCoord::new(1, 2).origin_tile(), TileCoord::new(32, 64));
        assert_eq!(ChunkCoord::new(-1, -1).origin_tile(), TileCoord::new(-32, -32));
    }

    #[test]
    fn roundtrip_positive() {
        for x in 0..100 {
            for y in 0..100 {
                let tc = TileCoord::new(x, y);
                let cc = tc.chunk();
                let (lx, ly) = tc.local();
                let reconstructed = TileCoord::new(
                    cc.x * CHUNK_SIZE + lx as i32,
                    cc.y * CHUNK_SIZE + ly as i32,
                );
                assert_eq!(tc, reconstructed, "roundtrip failed for ({x}, {y})");
            }
        }
    }

    #[test]
    fn roundtrip_negative() {
        for x in -100..0 {
            for y in -100..0 {
                let tc = TileCoord::new(x, y);
                let cc = tc.chunk();
                let (lx, ly) = tc.local();
                let reconstructed = TileCoord::new(
                    cc.x * CHUNK_SIZE + lx as i32,
                    cc.y * CHUNK_SIZE + ly as i32,
                );
                assert_eq!(tc, reconstructed, "roundtrip failed for ({x}, {y})");
            }
        }
    }
}
