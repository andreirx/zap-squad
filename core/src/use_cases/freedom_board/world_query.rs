//! Query operations on the SparseWorld.
//!
//! These are read-only operations that extract data for rendering,
//! export, or game logic. They do not mutate the world.

use crate::entities::freedom_board::{
    ChunkAABB, ChunkCoord, LODResult, SparseWorld, TileCoord, TilePlacement, VisibleTile,
    CHUNK_SIZE, MAX_LAYERS,
};

/// All tiles (across all layers) in a tile-coordinate viewport.
///
/// This is the primary query for close-zoom rendering: get every tile
/// that might be visible, then build GPU instances from them.
pub fn query_viewport(
    world: &SparseWorld,
    viewport_min: TileCoord,
    viewport_max: TileCoord,
) -> Vec<VisibleTile> {
    world.query_visible(viewport_min, viewport_max)
}

/// Adaptive LOD query for rendering at any zoom level.
///
/// Returns a mix of `LODResult::Detail` (render individual tiles from this chunk)
/// and `LODResult::Aggregate` (render a colored quad for this region).
///
/// # Parameters
/// - `viewport_min`, `viewport_max`: visible area in tile coordinates.
/// - `zoom`: camera zoom factor. At zoom 1.0, one tile = `base_tile_px` screen pixels.
/// - `base_tile_px`: screen pixels per tile at zoom 1.0 (typically 64).
/// - `detail_threshold`: minimum screen pixels for a chunk to render individually (typically 4.0).
pub fn query_viewport_lod(
    world: &SparseWorld,
    viewport_min: TileCoord,
    viewport_max: TileCoord,
    zoom: f32,
    base_tile_px: f32,
    detail_threshold: f32,
) -> Vec<LODResult> {
    let pixels_per_chunk = CHUNK_SIZE as f32 * base_tile_px * zoom;
    world.query_lod(viewport_min, viewport_max, pixels_per_chunk, detail_threshold)
}

/// Get all tiles (all layers) from a specific chunk, with world coordinates.
///
/// Useful for chunk-level operations like serialization or LOD thumbnail generation.
pub fn get_chunk_tiles(world: &SparseWorld, chunk: ChunkCoord) -> Vec<VisibleTile> {
    match world.get_chunk(chunk) {
        Some(c) => {
            let origin = chunk.origin_tile();
            c.iter_occupied()
                .map(|(lx, ly, tile)| VisibleTile {
                    x: origin.x + lx as i32,
                    y: origin.y + ly as i32,
                    placement: *tile,
                })
                .collect()
        }
        None => Vec::new(),
    }
}

/// Count tiles (across all layers) in a rectangular region without allocating a result vec.
pub fn count_tiles_in_rect(
    world: &SparseWorld,
    min: TileCoord,
    max: TileCoord,
) -> u64 {
    // Use the index to find relevant chunks, then count within bounds
    let chunk_min = min.chunk();
    let chunk_max = max.chunk();
    let chunk_rect = ChunkAABB::new(
        chunk_min.x,
        chunk_min.y,
        chunk_max.x + 1,
        chunk_max.y + 1,
    );

    let mut count = 0u64;
    // Iterate chunks directly from the world for counting
    // (avoids allocating Vec<ChunkCoord> from the quadtree)
    for cx in chunk_rect.min_x..chunk_rect.max_x {
        for cy in chunk_rect.min_y..chunk_rect.max_y {
            if let Some(chunk) = world.get_chunk(ChunkCoord::new(cx, cy)) {
                let origin_x = cx * CHUNK_SIZE;
                let origin_y = cy * CHUNK_SIZE;

                // If entire chunk is within bounds, use tile_count directly
                if origin_x >= min.x
                    && origin_x + CHUNK_SIZE - 1 <= max.x
                    && origin_y >= min.y
                    && origin_y + CHUNK_SIZE - 1 <= max.y
                {
                    count += chunk.tile_count() as u64;
                } else {
                    // Partial overlap — count individually
                    for (lx, ly, _) in chunk.iter_occupied() {
                        let wx = origin_x + lx as i32;
                        let wy = origin_y + ly as i32;
                        if wx >= min.x && wx <= max.x && wy >= min.y && wy <= max.y {
                            count += 1;
                        }
                    }
                }
            }
        }
    }

    count
}

/// Check if any layer at the given position has a tile.
///
/// Returns `false` if the position is entirely empty (all layers None).
pub fn is_occupied(world: &SparseWorld, coord: TileCoord) -> bool {
    let stack = world.get_stack(coord);
    stack.iter().any(|s| s.is_some())
}

/// Check if a specific layer at the given position has a tile.
pub fn is_occupied_on_layer(world: &SparseWorld, coord: TileCoord, layer: u8) -> bool {
    world.get(coord, layer).is_some()
}

/// Get the 4-connected neighbor tiles on a specific layer for
/// transition/connectivity calculations.
///
/// Returns `[N, E, S, W]` — the same order as the existing MapEditor's
/// connectivity bitmask (N=8, S=4, W=2, E=1).
pub fn cardinal_neighbors(
    world: &SparseWorld,
    coord: TileCoord,
    layer: u8,
) -> [Option<TilePlacement>; 4] {
    world.neighbors_4(coord, layer)
}

/// Compute a 4-bit connectivity bitmask for a tile on a specific layer.
///
/// Bits: N=8, S=4, W=2, E=1. A bit is set if the neighbor on the same
/// layer exists and has the same asset_id as the tile at `coord`.
///
/// Returns 0 if the position is empty on this layer.
pub fn connectivity_bitmask(world: &SparseWorld, coord: TileCoord, layer: u8) -> u8 {
    let Some(center) = world.get(coord, layer) else {
        return 0;
    };
    let aid = center.asset_id;

    let [n, e, s, w] = world.neighbors_4(coord, layer);

    let mut bits = 0u8;
    if n.map_or(false, |t| t.asset_id == aid) {
        bits |= 8;
    }
    if s.map_or(false, |t| t.asset_id == aid) {
        bits |= 4;
    }
    if w.map_or(false, |t| t.asset_id == aid) {
        bits |= 2;
    }
    if e.map_or(false, |t| t.asset_id == aid) {
        bits |= 1;
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::freedom_board::TilePlacement;

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
    fn connectivity_cross() {
        let mut world = SparseWorld::new();
        let grass = tile(1);
        world.set(tc(5, 5), grass);
        world.set(tc(5, 4), grass); // N
        world.set(tc(6, 5), grass); // E
        world.set(tc(5, 6), grass); // S
        world.set(tc(4, 5), grass); // W

        assert_eq!(connectivity_bitmask(&world, tc(5, 5), 0), 0b1111); // all 4
    }

    #[test]
    fn connectivity_partial() {
        let mut world = SparseWorld::new();
        let grass = tile(1);
        world.set(tc(5, 5), grass);
        world.set(tc(5, 4), grass); // N only

        assert_eq!(connectivity_bitmask(&world, tc(5, 5), 0), 0b1000); // N=8
    }

    #[test]
    fn connectivity_different_assets_ignored() {
        let mut world = SparseWorld::new();
        world.set(tc(5, 5), tile(1));
        world.set(tc(5, 4), tile(2)); // different asset — not connected

        assert_eq!(connectivity_bitmask(&world, tc(5, 5), 0), 0);
    }

    #[test]
    fn connectivity_empty_center() {
        let world = SparseWorld::new();
        assert_eq!(connectivity_bitmask(&world, tc(0, 0), 0), 0);
    }

    #[test]
    fn connectivity_layer_specific() {
        let mut world = SparseWorld::new();
        // Place paths on layer 3
        world.set(tc(5, 5), tile_on(10, 3));
        world.set(tc(5, 4), tile_on(10, 3)); // N on layer 3
        world.set(tc(6, 5), tile_on(10, 3)); // E on layer 3
        // Place different tile on layer 0 at north
        world.set(tc(5, 4), tile_on(99, 0));

        // Layer 3: connected N and E
        assert_eq!(connectivity_bitmask(&world, tc(5, 5), 3), 0b1001); // N=8, E=1
        // Layer 0: no tile at center on layer 0
        assert_eq!(connectivity_bitmask(&world, tc(5, 5), 0), 0);
    }

    #[test]
    fn is_occupied_any_layer() {
        let mut world = SparseWorld::new();
        assert!(!is_occupied(&world, tc(5, 5)));

        world.set(tc(5, 5), tile_on(1, 3)); // only on layer 3
        assert!(is_occupied(&world, tc(5, 5)));
        assert!(!is_occupied_on_layer(&world, tc(5, 5), 0));
        assert!(is_occupied_on_layer(&world, tc(5, 5), 3));
    }

    #[test]
    fn count_tiles_full_chunks() {
        let mut world = SparseWorld::new();
        for x in 0..64 {
            for y in 0..64 {
                world.set(tc(x, y), tile(1));
            }
        }

        let count = count_tiles_in_rect(&world, tc(0, 0), tc(63, 63));
        assert_eq!(count, 4096);

        let count = count_tiles_in_rect(&world, tc(10, 10), tc(50, 50));
        assert_eq!(count, 41 * 41);
    }

    #[test]
    fn count_tiles_multi_layer() {
        let mut world = SparseWorld::new();
        for x in 0..4 {
            for y in 0..4 {
                world.set(tc(x, y), tile_on(1, 0));
                world.set(tc(x, y), tile_on(2, 3));
            }
        }
        // 16 cells × 2 layers = 32 tiles
        let count = count_tiles_in_rect(&world, tc(0, 0), tc(3, 3));
        assert_eq!(count, 32);
    }

    #[test]
    fn query_viewport_basic() {
        let mut world = SparseWorld::new();
        world.set(tc(0, 0), tile(1));
        world.set(tc(100, 100), tile(2));

        let visible = query_viewport(&world, tc(-5, -5), tc(5, 5));
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].placement.asset_id, 1);
    }
}
