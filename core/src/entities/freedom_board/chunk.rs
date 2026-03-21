//! A 32×32 block of tiles — the fundamental storage unit.
//!
//! Each cell holds up to `MAX_LAYERS` (8) stacked tiles, indexed by
//! `TilePlacement.layer`. Memory per chunk: 8 bytes × 8 layers × 1024 cells
//! = 64 KB. This exceeds 32 KB L1 on x86 but fits Apple Silicon's 64–128 KB L1.
//!
//! Layer semantics (bottom to top):
//!   0 = Ground (terrain: grass, dirt, stone)
//!   1 = Water  (rivers, oceans)
//!   2 = Bridge (auto-placed over water under paths)
//!   3 = Path   (roads, land paths)
//!   4–7 = Reserved (objects, characters, VFX, UI)

use serde::{Deserialize, Serialize};

use super::coords::{CHUNK_AREA, CHUNK_SIZE, MAX_LAYERS};
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
    /// Fraction of cells occupied: `tile_count / (CHUNK_AREA * MAX_LAYERS)`.
    pub density: f32,
    /// Highest render layer in use (0-7).
    pub top_layer: u8,
}

/// A 32×32 block of layered tile placements.
///
/// Stored in a `HashMap<ChunkCoord, Chunk>` by `SparseWorld`.
/// Only chunks with at least one tile exist in memory.
pub struct Chunk {
    /// `tiles[cell_index][layer]` — each cell has MAX_LAYERS slots.
    tiles: [[Option<TilePlacement>; MAX_LAYERS]; CHUNK_AREA],
    /// Total number of occupied layer slots across all cells.
    tile_count: u16,
    dirty: bool,
    lod: ChunkLOD,
}

impl Chunk {
    pub fn new() -> Self {
        Self {
            tiles: [[None; MAX_LAYERS]; CHUNK_AREA],
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

    /// Read tile at local coordinates on a specific layer.
    /// Returns `None` if the layer slot is empty.
    #[inline]
    pub fn get(&self, lx: usize, ly: usize, layer: u8) -> Option<&TilePlacement> {
        debug_assert!(
            (layer as usize) < MAX_LAYERS,
            "layer {layer} out of range 0..{MAX_LAYERS}"
        );
        self.tiles[Self::index(lx, ly)][layer as usize].as_ref()
    }

    /// Get the full layer stack at local coordinates.
    /// Returns all MAX_LAYERS slots (some may be None).
    #[inline]
    pub fn get_stack(&self, lx: usize, ly: usize) -> &[Option<TilePlacement>; MAX_LAYERS] {
        &self.tiles[Self::index(lx, ly)]
    }

    /// Place a tile at local coordinates. The tile's `layer` field determines
    /// which slot to use. Returns the previous occupant of that slot if any.
    pub fn set(&mut self, lx: usize, ly: usize, tile: TilePlacement) -> Option<TilePlacement> {
        let idx = Self::index(lx, ly);
        let layer = tile.layer as usize;
        debug_assert!(
            layer < MAX_LAYERS,
            "tile.layer {} out of range 0..{MAX_LAYERS}",
            tile.layer
        );
        let old = self.tiles[idx][layer].replace(tile);
        if old.is_none() {
            self.tile_count += 1;
        }
        self.dirty = true;
        old
    }

    /// Remove the tile at local coordinates on a specific layer.
    /// Returns the removed tile if any.
    pub fn remove(&mut self, lx: usize, ly: usize, layer: u8) -> Option<TilePlacement> {
        let idx = Self::index(lx, ly);
        debug_assert!(
            (layer as usize) < MAX_LAYERS,
            "layer {layer} out of range 0..{MAX_LAYERS}"
        );
        let old = self.tiles[idx][layer as usize].take();
        if old.is_some() {
            self.tile_count -= 1;
            self.dirty = true;
        }
        old
    }

    /// True if no tiles exist in this chunk (across all layers and cells).
    pub fn is_empty(&self) -> bool {
        self.tile_count == 0
    }

    /// Number of occupied layer slots across all cells.
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

    /// Iterate over all occupied layer slots.
    /// Yields `(local_x, local_y, &TilePlacement)` — the tile's `.layer` field
    /// identifies which layer it occupies.
    pub fn iter_occupied(&self) -> impl Iterator<Item = (usize, usize, &TilePlacement)> {
        self.tiles.iter().enumerate().flat_map(|(idx, layers)| {
            let lx = idx % CHUNK_SIZE as usize;
            let ly = idx / CHUNK_SIZE as usize;
            layers
                .iter()
                .filter_map(move |slot| slot.as_ref().map(|t| (lx, ly, t)))
        })
    }

    /// Direct access to the tile array (for serialization).
    pub fn tiles(&self) -> &[[Option<TilePlacement>; MAX_LAYERS]; CHUNK_AREA] {
        &self.tiles
    }

    /// Recompute LOD from current tile data.
    ///
    /// This is a simple density calculation. A more sophisticated version
    /// would compute dominant color from the asset registry, but that requires
    /// adapter-layer knowledge. For now, LOD color is set externally via `set_lod`.
    pub fn recompute_density(&mut self) {
        let mut top_layer = 0u8;
        for tile in self.tiles.iter().flat_map(|layers| layers.iter()).flatten() {
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

    fn tile_on(id: u16, layer: u8) -> TilePlacement {
        TilePlacement::new(id, 0, layer)
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
        assert!(chunk.get(5, 10, 0).is_none());

        let old = chunk.set(5, 10, tile(42));
        assert!(old.is_none());
        assert_eq!(chunk.tile_count(), 1);
        assert_eq!(chunk.get(5, 10, 0).unwrap().asset_id, 42);
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
        let removed = chunk.remove(3, 3, 0);
        assert_eq!(removed.unwrap().asset_id, 99);
        assert!(chunk.is_empty());
    }

    #[test]
    fn remove_empty_returns_none() {
        let mut chunk = Chunk::new();
        assert!(chunk.remove(0, 0, 0).is_none());
        assert_eq!(chunk.tile_count(), 0);
    }

    #[test]
    fn multi_layer_same_cell() {
        let mut chunk = Chunk::new();
        chunk.set(5, 5, tile_on(1, 0)); // ground
        chunk.set(5, 5, tile_on(2, 1)); // water
        chunk.set(5, 5, tile_on(3, 3)); // path

        assert_eq!(chunk.tile_count(), 3);
        assert_eq!(chunk.get(5, 5, 0).unwrap().asset_id, 1);
        assert_eq!(chunk.get(5, 5, 1).unwrap().asset_id, 2);
        assert!(chunk.get(5, 5, 2).is_none()); // layer 2 empty
        assert_eq!(chunk.get(5, 5, 3).unwrap().asset_id, 3);

        // Remove one layer
        chunk.remove(5, 5, 1);
        assert_eq!(chunk.tile_count(), 2);
        assert!(chunk.get(5, 5, 1).is_none());
        // Others untouched
        assert_eq!(chunk.get(5, 5, 0).unwrap().asset_id, 1);
        assert_eq!(chunk.get(5, 5, 3).unwrap().asset_id, 3);
    }

    #[test]
    fn get_stack() {
        let mut chunk = Chunk::new();
        chunk.set(2, 3, tile_on(10, 0));
        chunk.set(2, 3, tile_on(20, 3));

        let stack = chunk.get_stack(2, 3);
        assert_eq!(stack[0].unwrap().asset_id, 10);
        assert!(stack[1].is_none());
        assert!(stack[2].is_none());
        assert_eq!(stack[3].unwrap().asset_id, 20);
        for i in 4..MAX_LAYERS {
            assert!(stack[i].is_none());
        }
    }

    #[test]
    fn iter_occupied() {
        let mut chunk = Chunk::new();
        chunk.set(0, 0, tile_on(1, 0));
        chunk.set(0, 0, tile_on(2, 2));
        chunk.set(31, 31, tile_on(3, 0));
        chunk.set(15, 15, tile_on(4, 7));

        let mut tiles: Vec<_> = chunk.iter_occupied().collect();
        tiles.sort_by_key(|(lx, ly, t)| (*lx, *ly, t.layer));

        assert_eq!(tiles.len(), 4);
        assert_eq!((tiles[0].0, tiles[0].1, tiles[0].2.asset_id, tiles[0].2.layer), (0, 0, 1, 0));
        assert_eq!((tiles[1].0, tiles[1].1, tiles[1].2.asset_id, tiles[1].2.layer), (0, 0, 2, 2));
        assert_eq!((tiles[2].0, tiles[2].1, tiles[2].2.asset_id, tiles[2].2.layer), (15, 15, 4, 7));
        assert_eq!((tiles[3].0, tiles[3].1, tiles[3].2.asset_id, tiles[3].2.layer), (31, 31, 3, 0));
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
        chunk.remove(0, 0, 0);
        assert!(chunk.is_dirty());
    }

    #[test]
    fn recompute_density() {
        let mut chunk = Chunk::new();
        chunk.set(0, 0, tile_on(1, 0));
        chunk.set(1, 0, tile_on(2, 3));
        chunk.set(1, 0, tile_on(3, 0)); // same cell, different layer
        chunk.recompute_density();

        let expected_density = 3.0 / CHUNK_AREA as f32;
        assert!((chunk.lod().density - expected_density).abs() < 1e-6);
        assert_eq!(chunk.lod().top_layer, 3);
    }

    #[test]
    fn boundary_coords() {
        let mut chunk = Chunk::new();
        // All four corners, mixed layers
        chunk.set(0, 0, tile_on(1, 0));
        chunk.set(31, 0, tile_on(2, 7));
        chunk.set(0, 31, tile_on(3, 3));
        chunk.set(31, 31, tile_on(4, 0));
        assert_eq!(chunk.tile_count(), 4);
    }

    #[test]
    #[should_panic(expected = "out of range")]
    fn out_of_bounds_panics_debug() {
        let chunk = Chunk::new();
        let _ = chunk.get(32, 0, 0);
    }

    #[test]
    fn chunk_memory_size() {
        // Verify the chunk storage size matches expectations.
        // 8 bytes per Option<TilePlacement> × 8 layers × 1024 cells = 65,536 bytes.
        let cell_size = std::mem::size_of::<[Option<TilePlacement>; MAX_LAYERS]>();
        assert_eq!(cell_size, 8 * MAX_LAYERS); // 64 bytes per cell
        let total = cell_size * CHUNK_AREA;
        assert_eq!(total, 65_536); // 64 KB
    }
}
