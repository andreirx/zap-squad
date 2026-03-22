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
//! - **Layer stacking**: Each cell holds up to `MAX_LAYERS` (8) tiles, indexed
//!   by `TilePlacement.layer`. Memory per chunk: 64 KB (8 layers × 8 KB).
//!
//! Only chunks containing at least one tile exist. When the last tile in a chunk
//! is removed, the chunk is dropped and its entry removed from the quadtree.

use std::collections::HashMap;

use super::chunk::Chunk;
use super::coords::{ChunkCoord, TileCoord, MAX_LAYERS};
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

    /// Read tile at the given coordinate on a specific layer.
    /// Returns `None` if the cell or layer slot is empty.
    pub fn get(&self, coord: TileCoord, layer: u8) -> Option<&TilePlacement> {
        let cc = coord.chunk();
        let (lx, ly) = coord.local();
        self.chunks.get(&cc)?.get(lx, ly, layer)
    }

    /// Get the full layer stack at a coordinate.
    /// Returns `[None; MAX_LAYERS]` if the chunk doesn't exist.
    pub fn get_stack(&self, coord: TileCoord) -> [Option<TilePlacement>; MAX_LAYERS] {
        let cc = coord.chunk();
        let (lx, ly) = coord.local();
        match self.chunks.get(&cc) {
            Some(chunk) => *chunk.get_stack(lx, ly),
            None => [None; MAX_LAYERS],
        }
    }

    /// Place a tile. The tile's `layer` field determines which slot to use.
    /// Returns the previous occupant of that slot if any.
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

    /// Remove the tile at the given coordinate on a specific layer.
    /// Returns the removed tile if any.
    ///
    /// Destroys the chunk if it becomes empty. Updates the quadtree index.
    pub fn remove(&mut self, coord: TileCoord, layer: u8) -> Option<TilePlacement> {
        let cc = coord.chunk();
        let (lx, ly) = coord.local();

        let chunk = self.chunks.get_mut(&cc)?;
        let old = chunk.remove(lx, ly, layer)?;

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

    /// Get the 4 cardinal neighbors on a specific layer (N, E, S, W).
    /// Returns `[north, east, south, west]`. Each may be `None` if empty.
    pub fn neighbors_4(&self, coord: TileCoord, layer: u8) -> [Option<TilePlacement>; 4] {
        [
            self.get(TileCoord::new(coord.x, coord.y - 1), layer).copied(), // N
            self.get(TileCoord::new(coord.x + 1, coord.y), layer).copied(), // E
            self.get(TileCoord::new(coord.x, coord.y + 1), layer).copied(), // S
            self.get(TileCoord::new(coord.x - 1, coord.y), layer).copied(), // W
        ]
    }

    /// Get all 8 neighbors on a specific layer (N, NE, E, SE, S, SW, W, NW).
    pub fn neighbors_8(&self, coord: TileCoord, layer: u8) -> [Option<TilePlacement>; 8] {
        [
            self.get(TileCoord::new(coord.x, coord.y - 1), layer).copied(),     // N
            self.get(TileCoord::new(coord.x + 1, coord.y - 1), layer).copied(), // NE
            self.get(TileCoord::new(coord.x + 1, coord.y), layer).copied(),     // E
            self.get(TileCoord::new(coord.x + 1, coord.y + 1), layer).copied(), // SE
            self.get(TileCoord::new(coord.x, coord.y + 1), layer).copied(),     // S
            self.get(TileCoord::new(coord.x - 1, coord.y + 1), layer).copied(), // SW
            self.get(TileCoord::new(coord.x - 1, coord.y), layer).copied(),     // W
            self.get(TileCoord::new(coord.x - 1, coord.y - 1), layer).copied(), // NW
        ]
    }

    // ── Spatial queries ────────────────────────────────────────────────────

    /// All tiles (across all layers) within the given tile-coordinate rectangle (inclusive).
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

    // ── Full-world iteration ────────────────────────────────────────────────

    /// Iterate over ALL tiles in the world, yielding `(world_coord, &TilePlacement)`.
    ///
    /// Iteration order is **unspecified** — depends on HashMap iteration order.
    /// For deterministic serialization, the caller must sort the output.
    ///
    /// Zero allocation: returns a composed iterator over chunks and their cells.
    pub fn iter_all(&self) -> impl Iterator<Item = (TileCoord, &TilePlacement)> {
        self.chunks.iter().flat_map(|(cc, chunk)| {
            let origin = cc.origin_tile();
            chunk.iter_occupied().map(move |(lx, ly, tile)| {
                (
                    TileCoord::new(origin.x + lx as i32, origin.y + ly as i32),
                    tile,
                )
            })
        })
    }

    /// Remove all tiles, chunks, and spatial index entries.
    ///
    /// After clear(), the world is in the same state as `SparseWorld::new()`
    /// except the generation counter continues incrementing (so renderers
    /// detect the change).
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.index = QuadTreeIndex::new();
        self.tile_count = 0;
        self.generation += 1;
    }

    // ── Statistics ──────────────────────────────────────────────────────────

    /// Total number of placed tiles across all chunks and layers.
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

    fn tile_on(id: u16, layer: u8) -> TilePlacement {
        TilePlacement::new(id, 0, layer)
    }

    #[test]
    fn empty_world() {
        let world = SparseWorld::new();
        assert_eq!(world.tile_count(), 0);
        assert_eq!(world.chunk_count(), 0);
        assert!(world.get(tc(0, 0), 0).is_none());
    }

    #[test]
    fn set_and_get() {
        let mut world = SparseWorld::new();
        world.set(tc(5, 10), tile(42));

        assert_eq!(world.tile_count(), 1);
        assert_eq!(world.chunk_count(), 1);
        assert_eq!(world.get(tc(5, 10), 0).unwrap().asset_id, 42);
    }

    #[test]
    fn set_overwrites() {
        let mut world = SparseWorld::new();
        world.set(tc(0, 0), tile(1));
        let old = world.set(tc(0, 0), tile(2));

        assert_eq!(old.unwrap().asset_id, 1);
        assert_eq!(world.get(tc(0, 0), 0).unwrap().asset_id, 2);
        assert_eq!(world.tile_count(), 1); // count unchanged
    }

    #[test]
    fn multi_layer_stacking() {
        let mut world = SparseWorld::new();
        world.set(tc(5, 5), tile_on(1, 0)); // ground
        world.set(tc(5, 5), tile_on(2, 1)); // water
        world.set(tc(5, 5), tile_on(3, 3)); // path

        assert_eq!(world.tile_count(), 3);
        assert_eq!(world.chunk_count(), 1);
        assert_eq!(world.get(tc(5, 5), 0).unwrap().asset_id, 1);
        assert_eq!(world.get(tc(5, 5), 1).unwrap().asset_id, 2);
        assert!(world.get(tc(5, 5), 2).is_none());
        assert_eq!(world.get(tc(5, 5), 3).unwrap().asset_id, 3);
    }

    #[test]
    fn get_stack() {
        let mut world = SparseWorld::new();
        world.set(tc(3, 3), tile_on(10, 0));
        world.set(tc(3, 3), tile_on(20, 2));

        let stack = world.get_stack(tc(3, 3));
        assert_eq!(stack[0].unwrap().asset_id, 10);
        assert!(stack[1].is_none());
        assert_eq!(stack[2].unwrap().asset_id, 20);
    }

    #[test]
    fn get_stack_missing_chunk() {
        let world = SparseWorld::new();
        let stack = world.get_stack(tc(999, 999));
        assert!(stack.iter().all(|s| s.is_none()));
    }

    #[test]
    fn remove() {
        let mut world = SparseWorld::new();
        world.set(tc(3, 3), tile(99));
        let removed = world.remove(tc(3, 3), 0);

        assert_eq!(removed.unwrap().asset_id, 99);
        assert!(world.get(tc(3, 3), 0).is_none());
        assert_eq!(world.tile_count(), 0);
        assert_eq!(world.chunk_count(), 0); // chunk cleaned up
    }

    #[test]
    fn remove_one_layer_keeps_others() {
        let mut world = SparseWorld::new();
        world.set(tc(3, 3), tile_on(1, 0));
        world.set(tc(3, 3), tile_on(2, 2));

        world.remove(tc(3, 3), 0);
        assert_eq!(world.tile_count(), 1);
        assert_eq!(world.chunk_count(), 1); // still has layer 2
        assert!(world.get(tc(3, 3), 0).is_none());
        assert_eq!(world.get(tc(3, 3), 2).unwrap().asset_id, 2);
    }

    #[test]
    fn remove_nonexistent() {
        let mut world = SparseWorld::new();
        assert!(world.remove(tc(0, 0), 0).is_none());
    }

    #[test]
    fn negative_coordinates() {
        let mut world = SparseWorld::new();
        world.set(tc(-1, -1), tile(10));
        world.set(tc(-33, -33), tile(20));

        assert_eq!(world.get(tc(-1, -1), 0).unwrap().asset_id, 10);
        assert_eq!(world.get(tc(-33, -33), 0).unwrap().asset_id, 20);
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
    fn query_visible_multi_layer() {
        let mut world = SparseWorld::new();
        // Place 2 layers at each of 4 positions
        for x in 0..2 {
            for y in 0..2 {
                world.set(tc(x, y), tile_on(1, 0));
                world.set(tc(x, y), tile_on(2, 3));
            }
        }

        let visible = world.query_visible(tc(0, 0), tc(1, 1));
        assert_eq!(visible.len(), 8); // 4 cells × 2 layers each
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

        let [n, e, s, w] = world.neighbors_4(tc(5, 5), 0);
        assert_eq!(n.unwrap().asset_id, 1);
        assert_eq!(e.unwrap().asset_id, 2);
        assert_eq!(s.unwrap().asset_id, 3);
        assert!(w.is_none());
    }

    #[test]
    fn neighbors_4_layer_specific() {
        let mut world = SparseWorld::new();
        world.set(tc(5, 5), tile_on(0, 0));
        world.set(tc(5, 4), tile_on(1, 0)); // N on layer 0
        world.set(tc(5, 4), tile_on(9, 3)); // N on layer 3

        // Layer 0: sees tile 1 to the north
        let [n, _, _, _] = world.neighbors_4(tc(5, 5), 0);
        assert_eq!(n.unwrap().asset_id, 1);

        // Layer 3: sees tile 9 to the north
        let [n, _, _, _] = world.neighbors_4(tc(5, 5), 3);
        assert_eq!(n.unwrap().asset_id, 9);

        // Layer 1: sees nothing to the north
        let [n, _, _, _] = world.neighbors_4(tc(5, 5), 1);
        assert!(n.is_none());
    }

    #[test]
    fn generation_increments() {
        let mut world = SparseWorld::new();
        assert_eq!(world.generation(), 0);

        world.set(tc(0, 0), tile(1));
        assert_eq!(world.generation(), 1);

        world.set(tc(0, 0), tile(2)); // overwrite
        assert_eq!(world.generation(), 2);

        world.remove(tc(0, 0), 0);
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
        // 100/32 = 4 chunks per axis, ceil -> 4x4 = 16 chunks
        assert_eq!(world.chunk_count(), 16);

        // Query a 50x50 sub-region
        let visible = world.query_visible(tc(25, 25), tc(74, 74));
        assert_eq!(visible.len(), 2500);
    }

    // ── iter_all tests ──────────────────────────────────────────────────────

    #[test]
    fn iter_all_empty_world() {
        let world = SparseWorld::new();
        assert_eq!(world.iter_all().count(), 0);
    }

    #[test]
    fn iter_all_single_tile() {
        let mut world = SparseWorld::new();
        world.set(tc(5, 10), tile(42));

        let all: Vec<_> = world.iter_all().collect();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, tc(5, 10));
        assert_eq!(all[0].1.asset_id, 42);
    }

    #[test]
    fn iter_all_multi_layer_same_cell() {
        let mut world = SparseWorld::new();
        world.set(tc(3, 3), tile_on(10, 0));
        world.set(tc(3, 3), tile_on(20, 2));
        world.set(tc(3, 3), tile_on(30, 5));

        let mut all: Vec<_> = world.iter_all().collect();
        all.sort_by_key(|(_, t)| t.layer);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].1.asset_id, 10);
        assert_eq!(all[1].1.asset_id, 20);
        assert_eq!(all[2].1.asset_id, 30);
        // All at same world coord
        assert!(all.iter().all(|(c, _)| *c == tc(3, 3)));
    }

    #[test]
    fn iter_all_across_chunks() {
        let mut world = SparseWorld::new();
        world.set(tc(0, 0), tile(1));       // chunk (0,0)
        world.set(tc(50, 50), tile(2));     // chunk (1,1)
        world.set(tc(-10, -10), tile(3));   // chunk (-1,-1)

        assert_eq!(world.chunk_count(), 3);
        assert_eq!(world.iter_all().count(), 3);

        let mut all: Vec<_> = world.iter_all().collect();
        all.sort_by_key(|(c, _)| (c.x, c.y));
        assert_eq!(all[0].0, tc(-10, -10));
        assert_eq!(all[1].0, tc(0, 0));
        assert_eq!(all[2].0, tc(50, 50));
    }

    #[test]
    fn iter_all_count_matches_tile_count() {
        let mut world = SparseWorld::new();
        for x in 0..10 {
            for y in 0..10 {
                world.set(tc(x, y), tile_on((x + y) as u16, 0));
                world.set(tc(x, y), tile_on((x + y) as u16, 3));
            }
        }
        assert_eq!(world.tile_count(), 200);
        assert_eq!(world.iter_all().count(), 200);
    }

    // ── clear tests ─────────────────────────────────────────────────────────

    #[test]
    fn clear_empty_world() {
        let mut world = SparseWorld::new();
        let gen_before = world.generation();
        world.clear();
        assert_eq!(world.tile_count(), 0);
        assert_eq!(world.chunk_count(), 0);
        assert_eq!(world.generation(), gen_before + 1);
    }

    #[test]
    fn clear_populated_world() {
        let mut world = SparseWorld::new();
        for x in 0..50 {
            world.set(tc(x, 0), tile(x as u16));
        }
        assert_eq!(world.tile_count(), 50);
        assert!(world.chunk_count() > 0);

        let gen_before = world.generation();
        world.clear();

        assert_eq!(world.tile_count(), 0);
        assert_eq!(world.chunk_count(), 0);
        assert!(world.bounds().is_none());
        assert_eq!(world.generation(), gen_before + 1);
        // All tiles gone
        for x in 0..50 {
            assert!(world.get(tc(x, 0), 0).is_none());
        }
    }

    #[test]
    fn clear_then_reuse() {
        let mut world = SparseWorld::new();
        world.set(tc(0, 0), tile(1));
        world.clear();
        world.set(tc(10, 10), tile(99));

        assert_eq!(world.tile_count(), 1);
        assert_eq!(world.chunk_count(), 1);
        assert_eq!(world.get(tc(10, 10), 0).unwrap().asset_id, 99);
        assert!(world.get(tc(0, 0), 0).is_none());
    }
}
