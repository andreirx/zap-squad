//! The infinite sparse tile grid — the central entity of freedom-board.
//!
//! `SparseWorld` is the game world, the editor canvas, and the runtime state.
//! In edit mode, tiles are placed and removed. In play mode, Rhai scripts
//! read and mutate the same structure. The engine renders from it every frame.
//!
//! # Storage Model
//!
//! - **Primary storage**: `HashMap<ChunkCoord, Chunk>` — O(1) point access,
//!   cache-friendly for neighbor lookups within a chunk.
//! - **Spatial index**: `QuadTreeIndex` over non-empty chunks — O(log N) range
//!   queries, adaptive LOD for far-zoom rendering.
//!
//! Only chunks containing at least one tile exist. When the last tile in a chunk
//! is removed, the chunk is dropped and its entry removed from the quadtree.

use std::collections::HashMap;

use super::chunk::Chunk;
use super::coords::{ChunkCoord, TileCoord};
use super::quad_index::{ChunkAABB, LODResult, QuadDebugNode, QuadTreeIndex};
use super::tile_placement::TilePlacement;

/// A tile visible in the current viewport, with its world position.
#[derive(Clone, Debug)]
pub struct VisibleTile {
    pub x: i32,
    pub y: i32,
    pub placement: TilePlacement,
}

/// The infinite sparse tile grid.
pub struct SparseWorld {
    chunks: HashMap<ChunkCoord, Chunk>,
    index: QuadTreeIndex,
    tile_count: u64,
    /// Monotonically increasing counter, bumped on every mutation.
    /// Used by the renderer to detect changes and skip redundant work.
    generation: u64,
}

impl SparseWorld {
    pub fn new() -> Self {
        Self {
            chunks: HashMap::new(),
            index: QuadTreeIndex::new(),
            tile_count: 0,
            generation: 0,
        }
    }

    // ── Point operations ───────────────────────────────────────────────────

    /// Read tile at the given coordinate. Returns `None` if empty.
    pub fn get(&self, coord: TileCoord) -> Option<&TilePlacement> {
        let cc = coord.chunk();
        let (lx, ly) = coord.local();
        self.chunks.get(&cc)?.get(lx, ly)
    }

    /// Place a tile. Returns the previous occupant if any.
    ///
    /// Creates a new chunk if needed. Updates the quadtree index.
    pub fn set(&mut self, coord: TileCoord, tile: TilePlacement) -> Option<TilePlacement> {
        let cc = coord.chunk();
        let (lx, ly) = coord.local();
        let is_new_chunk = !self.chunks.contains_key(&cc);

        if is_new_chunk {
            self.chunks.insert(cc, Chunk::new());
        }

        let chunk = self.chunks.get_mut(&cc).unwrap();
        let old = chunk.set(lx, ly, tile);

        if old.is_none() {
            self.tile_count += 1;
        }
        self.generation += 1;

        // Sync quadtree
        chunk.recompute_density();
        let lod = *chunk.lod();
        let count = chunk.tile_count();
        if is_new_chunk {
            self.index.insert(cc, lod, count);
        } else {
            self.index.update_lod(cc, lod, count);
        }

        old
    }

    /// Remove the tile at the given coordinate. Returns the removed tile if any.
    ///
    /// Destroys the chunk if it becomes empty. Updates the quadtree index.
    pub fn remove(&mut self, coord: TileCoord) -> Option<TilePlacement> {
        let cc = coord.chunk();
        let (lx, ly) = coord.local();

        let chunk = self.chunks.get_mut(&cc)?;
        let old = chunk.remove(lx, ly)?;

        self.tile_count -= 1;
        self.generation += 1;

        if chunk.is_empty() {
            self.chunks.remove(&cc);
            self.index.remove(cc);
        } else {
            chunk.recompute_density();
            let lod = *chunk.lod();
            let count = chunk.tile_count();
            self.index.update_lod(cc, lod, count);
        }

        Some(old)
    }

    // ── Neighbor queries ───────────────────────────────────────────────────

    /// Get the 4 cardinal neighbors (N, E, S, W).
    /// Returns `[north, east, south, west]`. Each may be `None` if empty.
    pub fn neighbors_4(&self, coord: TileCoord) -> [Option<TilePlacement>; 4] {
        [
            self.get(TileCoord::new(coord.x, coord.y - 1)).copied(), // N
            self.get(TileCoord::new(coord.x + 1, coord.y)).copied(), // E
            self.get(TileCoord::new(coord.x, coord.y + 1)).copied(), // S
            self.get(TileCoord::new(coord.x - 1, coord.y)).copied(), // W
        ]
    }

    /// Get all 8 neighbors (N, NE, E, SE, S, SW, W, NW).
    pub fn neighbors_8(&self, coord: TileCoord) -> [Option<TilePlacement>; 8] {
        [
            self.get(TileCoord::new(coord.x, coord.y - 1)).copied(),     // N
            self.get(TileCoord::new(coord.x + 1, coord.y - 1)).copied(), // NE
            self.get(TileCoord::new(coord.x + 1, coord.y)).copied(),     // E
            self.get(TileCoord::new(coord.x + 1, coord.y + 1)).copied(), // SE
            self.get(TileCoord::new(coord.x, coord.y + 1)).copied(),     // S
            self.get(TileCoord::new(coord.x - 1, coord.y + 1)).copied(), // SW
            self.get(TileCoord::new(coord.x - 1, coord.y)).copied(),     // W
            self.get(TileCoord::new(coord.x - 1, coord.y - 1)).copied(), // NW
        ]
    }

    // ── Spatial queries ────────────────────────────────────────────────────

    /// All tiles within the given tile-coordinate rectangle (inclusive).
    pub fn query_visible(&self, min: TileCoord, max: TileCoord) -> Vec<VisibleTile> {
        // Convert tile bounds to chunk bounds (inclusive)
        let chunk_min = min.chunk();
        let chunk_max = max.chunk();
        let chunk_rect = ChunkAABB::new(
            chunk_min.x,
            chunk_min.y,
            chunk_max.x + 1, // exclusive upper bound
            chunk_max.y + 1,
        );

        let chunk_coords = self.index.query_rect(&chunk_rect);
        let mut result = Vec::new();

        for cc in chunk_coords {
            if let Some(chunk) = self.chunks.get(&cc) {
                let origin = cc.origin_tile();
                for (lx, ly, tile) in chunk.iter_occupied() {
                    let wx = origin.x + lx as i32;
                    let wy = origin.y + ly as i32;
                    if wx >= min.x && wx <= max.x && wy >= min.y && wy <= max.y {
                        result.push(VisibleTile {
                            x: wx,
                            y: wy,
                            placement: *tile,
                        });
                    }
                }
            }
        }

        result
    }

    /// Adaptive LOD query for rendering.
    ///
    /// Returns a mix of individual chunk coordinates (for close zoom) and
    /// aggregate regions (for far zoom).
    pub fn query_lod(
        &self,
        viewport_min: TileCoord,
        viewport_max: TileCoord,
        pixels_per_chunk: f32,
        detail_threshold: f32,
    ) -> Vec<LODResult> {
        let chunk_min = viewport_min.chunk();
        let chunk_max = viewport_max.chunk();
        let chunk_rect = ChunkAABB::new(
            chunk_min.x,
            chunk_min.y,
            chunk_max.x + 1,
            chunk_max.y + 1,
        );
        self.index
            .query_lod(&chunk_rect, pixels_per_chunk, detail_threshold)
    }

    /// Direct chunk access (for rendering). Returns `None` if chunk doesn't exist.
    pub fn get_chunk(&self, coord: ChunkCoord) -> Option<&Chunk> {
        self.chunks.get(&coord)
    }

    // ── Statistics ──────────────────────────────────────────────────────────

    /// Total number of placed tiles across all chunks.
    pub fn tile_count(&self) -> u64 {
        self.tile_count
    }

    /// Number of non-empty chunks.
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Monotonically increasing mutation counter.
    /// Changes every time a tile is placed or removed.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Debug visualization data for the quadtree spatial index.
    ///
    /// Returns all node bounds and metadata. For rendering quadtree
    /// boundaries during development.
    pub fn debug_quadtree_nodes(&self) -> Vec<QuadDebugNode> {
        self.index.debug_nodes()
    }

    /// Bounding box of all occupied chunks, or `None` if empty.
    pub fn bounds(&self) -> Option<ChunkAABB> {
        if self.chunks.is_empty() {
            return None;
        }
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        for cc in self.chunks.keys() {
            min_x = min_x.min(cc.x);
            min_y = min_y.min(cc.y);
            max_x = max_x.max(cc.x + 1);
            max_y = max_y.max(cc.y + 1);
        }
        Some(ChunkAABB::new(min_x, min_y, max_x, max_y))
    }
}

impl Default for SparseWorld {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tc(x: i32, y: i32) -> TileCoord {
        TileCoord::new(x, y)
    }

    fn tile(id: u16) -> TilePlacement {
        TilePlacement::new(id, 0, 0)
    }

    #[test]
    fn empty_world() {
        let world = SparseWorld::new();
        assert_eq!(world.tile_count(), 0);
        assert_eq!(world.chunk_count(), 0);
        assert!(world.get(tc(0, 0)).is_none());
    }

    #[test]
    fn set_and_get() {
        let mut world = SparseWorld::new();
        world.set(tc(5, 10), tile(42));

        assert_eq!(world.tile_count(), 1);
        assert_eq!(world.chunk_count(), 1);
        assert_eq!(world.get(tc(5, 10)).unwrap().asset_id, 42);
    }

    #[test]
    fn set_overwrites() {
        let mut world = SparseWorld::new();
        world.set(tc(0, 0), tile(1));
        let old = world.set(tc(0, 0), tile(2));

        assert_eq!(old.unwrap().asset_id, 1);
        assert_eq!(world.get(tc(0, 0)).unwrap().asset_id, 2);
        assert_eq!(world.tile_count(), 1); // count unchanged
    }

    #[test]
    fn remove() {
        let mut world = SparseWorld::new();
        world.set(tc(3, 3), tile(99));
        let removed = world.remove(tc(3, 3));

        assert_eq!(removed.unwrap().asset_id, 99);
        assert!(world.get(tc(3, 3)).is_none());
        assert_eq!(world.tile_count(), 0);
        assert_eq!(world.chunk_count(), 0); // chunk cleaned up
    }

    #[test]
    fn remove_nonexistent() {
        let mut world = SparseWorld::new();
        assert!(world.remove(tc(0, 0)).is_none());
    }

    #[test]
    fn negative_coordinates() {
        let mut world = SparseWorld::new();
        world.set(tc(-1, -1), tile(10));
        world.set(tc(-33, -33), tile(20));

        assert_eq!(world.get(tc(-1, -1)).unwrap().asset_id, 10);
        assert_eq!(world.get(tc(-33, -33)).unwrap().asset_id, 20);
        assert_eq!(world.chunk_count(), 2); // different chunks
    }

    #[test]
    fn tiles_in_same_chunk() {
        let mut world = SparseWorld::new();
        world.set(tc(0, 0), tile(1));
        world.set(tc(1, 0), tile(2));
        world.set(tc(31, 31), tile(3));

        assert_eq!(world.tile_count(), 3);
        assert_eq!(world.chunk_count(), 1); // all in chunk (0,0)
    }

    #[test]
    fn query_visible() {
        let mut world = SparseWorld::new();
        for x in 0..10 {
            for y in 0..10 {
                world.set(tc(x, y), tile((x * 10 + y) as u16));
            }
        }

        let visible = world.query_visible(tc(2, 2), tc(5, 5));
        assert_eq!(visible.len(), 16); // 4x4 region

        // Verify all are in range
        for vt in &visible {
            assert!(vt.x >= 2 && vt.x <= 5);
            assert!(vt.y >= 2 && vt.y <= 5);
        }
    }

    #[test]
    fn query_visible_spanning_chunks() {
        let mut world = SparseWorld::new();
        // Place tiles across chunk boundary (chunk 0 ends at 31, chunk 1 starts at 32)
        for x in 30..35 {
            world.set(tc(x, 0), tile(x as u16));
        }

        assert_eq!(world.chunk_count(), 2); // chunks 0 and 1

        let visible = world.query_visible(tc(30, 0), tc(34, 0));
        assert_eq!(visible.len(), 5);
    }

    #[test]
    fn neighbors_4() {
        let mut world = SparseWorld::new();
        world.set(tc(5, 5), tile(0));
        world.set(tc(5, 4), tile(1)); // N
        world.set(tc(6, 5), tile(2)); // E
        world.set(tc(5, 6), tile(3)); // S
        // W is empty

        let [n, e, s, w] = world.neighbors_4(tc(5, 5));
        assert_eq!(n.unwrap().asset_id, 1);
        assert_eq!(e.unwrap().asset_id, 2);
        assert_eq!(s.unwrap().asset_id, 3);
        assert!(w.is_none());
    }

    #[test]
    fn generation_increments() {
        let mut world = SparseWorld::new();
        assert_eq!(world.generation(), 0);

        world.set(tc(0, 0), tile(1));
        assert_eq!(world.generation(), 1);

        world.set(tc(0, 0), tile(2)); // overwrite
        assert_eq!(world.generation(), 2);

        world.remove(tc(0, 0));
        assert_eq!(world.generation(), 3);
    }

    #[test]
    fn bounds_tracking() {
        let mut world = SparseWorld::new();
        assert!(world.bounds().is_none());

        world.set(tc(10, 20), tile(1));
        world.set(tc(100, 200), tile(2));

        let b = world.bounds().unwrap();
        assert_eq!(b.min_x, 0); // chunk(10/32) = 0
        assert_eq!(b.min_y, 0); // chunk(20/32) = 0
        assert_eq!(b.max_x, 4); // chunk(100/32) = 3, +1 = 4
        assert_eq!(b.max_y, 7); // chunk(200/32) = 6, +1 = 7
    }

    #[test]
    fn large_scale_insert_and_query() {
        let mut world = SparseWorld::new();
        // Place 10,000 tiles in a 100x100 area
        for x in 0..100 {
            for y in 0..100 {
                world.set(tc(x, y), tile((x + y) as u16));
            }
        }

        assert_eq!(world.tile_count(), 10_000);
        // 100/32 = 4 chunks per axis, ceil → 4x4 = 16 chunks
        assert_eq!(world.chunk_count(), 16);

        // Query a 50x50 sub-region
        let visible = world.query_visible(tc(25, 25), tc(74, 74));
        assert_eq!(visible.len(), 2500);
    }
}
