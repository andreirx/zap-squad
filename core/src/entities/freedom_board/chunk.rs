//! A 32x32 block of tiles — the fundamental storage unit.
//!
//! Chunks are the bridge between individual tile operations (O(1) via array index)
//! and spatial queries (via the quadtree over chunks). Memory per chunk is ~8KB when
//! fully populated (8 bytes per Option<TilePlacement> x 1024 cells), fitting in
//! L1 cache for fast sequential neighbor lookups during transition and connectivity
//! calculations.

use serde::{Deserialize, Serialize};

use super::coords::{CHUNK_AREA, CHUNK_SIZE};
use super::tile_placement::TilePlacement;

/// Level-of-detail summary for a chunk.
///
/// Cached on the chunk and propagated to the quadtree for far-zoom rendering.
/// When a chunk is too small to render individual tiles, the renderer draws
/// a single colored quad using this data.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct ChunkLOD {
    /// RGBA average color of all occupied tiles in this chunk.
    pub dominant_color: [u8; 4],
    /// Fraction of cells occupied: `tile_count / CHUNK_AREA`.
    pub density: f32,
    /// Highest render layer in use (0-5).
    pub top_layer: u8,
}

/// A 32x32 block of optional tile placements.
///
/// Stored in a `HashMap<ChunkCoord, Chunk>` by `SparseWorld`.
/// Only chunks with at least one tile exist in memory.
pub struct Chunk {
    tiles: [Option<TilePlacement>; CHUNK_AREA],
    tile_count: u16,
    dirty: bool,
    lod: ChunkLOD,
}

impl Chunk {
    pub fn new() -> Self {
        Self {
            tiles: [None; CHUNK_AREA],
            tile_count: 0,
            dirty: true,
            lod: ChunkLOD::default(),
        }
    }

    /// Flat array index from local coordinates.
    /// Row-major order: index = ly * CHUNK_SIZE + lx.
    #[inline]
    fn index(lx: usize, ly: usize) -> usize {
        debug_assert!(
            lx < CHUNK_SIZE as usize && ly < CHUNK_SIZE as usize,
            "local coords ({lx}, {ly}) out of range 0..{CHUNK_SIZE}"
        );
        ly * CHUNK_SIZE as usize + lx
    }

    /// Read tile at local coordinates. Returns `None` if the cell is empty.
    #[inline]
    pub fn get(&self, lx: usize, ly: usize) -> Option<&TilePlacement> {
        self.tiles[Self::index(lx, ly)].as_ref()
    }

    /// Place a tile at local coordinates. Returns the previous occupant if any.
    pub fn set(&mut self, lx: usize, ly: usize, tile: TilePlacement) -> Option<TilePlacement> {
        let idx = Self::index(lx, ly);
        let old = self.tiles[idx].replace(tile);
        if old.is_none() {
            self.tile_count += 1;
        }
        self.dirty = true;
        old
    }

    /// Remove the tile at local coordinates. Returns the removed tile if any.
    pub fn remove(&mut self, lx: usize, ly: usize) -> Option<TilePlacement> {
        let idx = Self::index(lx, ly);
        let old = self.tiles[idx].take();
        if old.is_some() {
            self.tile_count -= 1;
            self.dirty = true;
        }
        old
    }

    /// True if no tiles exist in this chunk.
    pub fn is_empty(&self) -> bool {
        self.tile_count == 0
    }

    /// Number of occupied cells.
    pub fn tile_count(&self) -> u16 {
        self.tile_count
    }

    /// True if tiles have been modified since the last `mark_clean()`.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Reset the dirty flag after LOD recomputation.
    pub fn mark_clean(&mut self) {
        self.dirty = false;
    }

    pub fn lod(&self) -> &ChunkLOD {
        &self.lod
    }

    pub fn set_lod(&mut self, lod: ChunkLOD) {
        self.lod = lod;
    }

    /// Iterate over all occupied cells.
    /// Yields `(local_x, local_y, &TilePlacement)`.
    pub fn iter_occupied(&self) -> impl Iterator<Item = (usize, usize, &TilePlacement)> {
        self.tiles.iter().enumerate().filter_map(|(idx, tile)| {
            tile.as_ref().map(|t| {
                let lx = idx % CHUNK_SIZE as usize;
                let ly = idx / CHUNK_SIZE as usize;
                (lx, ly, t)
            })
        })
    }

    /// Direct access to the tile array (for serialization).
    pub fn tiles(&self) -> &[Option<TilePlacement>; CHUNK_AREA] {
        &self.tiles
    }

    /// Recompute LOD from current tile data.
    ///
    /// This is a simple density calculation. A more sophisticated version
    /// would compute dominant color from the asset registry, but that requires
    /// adapter-layer knowledge. For now, LOD color is set externally via `set_lod`.
    pub fn recompute_density(&mut self) {
        let mut top_layer = 0u8;
        for tile in self.tiles.iter().flatten() {
            if tile.layer > top_layer {
                top_layer = tile.layer;
            }
        }
        self.lod.density = self.tile_count as f32 / CHUNK_AREA as f32;
        self.lod.top_layer = top_layer;
    }
}

impl Default for Chunk {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(id: u16) -> TilePlacement {
        TilePlacement::new(id, 0, 0)
    }

    #[test]
    fn new_chunk_is_empty() {
        let chunk = Chunk::new();
        assert!(chunk.is_empty());
        assert_eq!(chunk.tile_count(), 0);
        assert!(chunk.is_dirty()); // new chunks start dirty
    }

    #[test]
    fn set_and_get() {
        let mut chunk = Chunk::new();
        assert!(chunk.get(5, 10).is_none());

        let old = chunk.set(5, 10, tile(42));
        assert!(old.is_none());
        assert_eq!(chunk.tile_count(), 1);
        assert_eq!(chunk.get(5, 10).unwrap().asset_id, 42);
    }

    #[test]
    fn overwrite_returns_old() {
        let mut chunk = Chunk::new();
        chunk.set(0, 0, tile(1));
        let old = chunk.set(0, 0, tile(2));
        assert_eq!(old.unwrap().asset_id, 1);
        assert_eq!(chunk.tile_count(), 1); // count doesn't change on overwrite
    }

    #[test]
    fn remove_returns_tile() {
        let mut chunk = Chunk::new();
        chunk.set(3, 3, tile(99));
        let removed = chunk.remove(3, 3);
        assert_eq!(removed.unwrap().asset_id, 99);
        assert!(chunk.is_empty());
    }

    #[test]
    fn remove_empty_returns_none() {
        let mut chunk = Chunk::new();
        assert!(chunk.remove(0, 0).is_none());
        assert_eq!(chunk.tile_count(), 0);
    }

    #[test]
    fn iter_occupied() {
        let mut chunk = Chunk::new();
        chunk.set(0, 0, tile(1));
        chunk.set(31, 31, tile(2));
        chunk.set(15, 15, tile(3));

        let mut tiles: Vec<_> = chunk.iter_occupied().collect();
        tiles.sort_by_key(|(lx, ly, _)| (*lx, *ly));

        assert_eq!(tiles.len(), 3);
        assert_eq!(tiles[0], (0, 0, &tile(1)));
        assert_eq!(tiles[1], (15, 15, &tile(3)));
        assert_eq!(tiles[2], (31, 31, &tile(2)));
    }

    #[test]
    fn dirty_flag_lifecycle() {
        let mut chunk = Chunk::new();
        assert!(chunk.is_dirty());

        chunk.mark_clean();
        assert!(!chunk.is_dirty());

        chunk.set(0, 0, tile(1));
        assert!(chunk.is_dirty());

        chunk.mark_clean();
        chunk.remove(0, 0);
        assert!(chunk.is_dirty());
    }

    #[test]
    fn recompute_density() {
        let mut chunk = Chunk::new();
        chunk.set(0, 0, TilePlacement::new(1, 0, 0));
        chunk.set(1, 0, TilePlacement::new(2, 0, 3));
        chunk.recompute_density();

        let expected_density = 2.0 / CHUNK_AREA as f32;
        assert!((chunk.lod().density - expected_density).abs() < 1e-6);
        assert_eq!(chunk.lod().top_layer, 3);
    }

    #[test]
    fn boundary_coords() {
        let mut chunk = Chunk::new();
        // All four corners
        chunk.set(0, 0, tile(1));
        chunk.set(31, 0, tile(2));
        chunk.set(0, 31, tile(3));
        chunk.set(31, 31, tile(4));
        assert_eq!(chunk.tile_count(), 4);
    }

    #[test]
    #[should_panic(expected = "out of range")]
    fn out_of_bounds_panics_debug() {
        let chunk = Chunk::new();
        let _ = chunk.get(32, 0);
    }
}
