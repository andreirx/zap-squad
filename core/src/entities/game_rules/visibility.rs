//! Team visibility — per-team fog-of-war state with sparse chunked storage.
//!
//! Aligned to the SparseWorld chunk model: visibility is stored per-chunk
//! in a HashMap, not as a single dense rectangle. This supports infinite
//! canvas worlds without bounded-grid assumptions.
//!
//! # Storage
//!
//! Only chunks that have been observed (or are near observers) carry state.
//! Untracked chunks are implicitly Hidden. This is the correct default for
//! an infinite sparse world: what you haven't seen doesn't exist in the
//! visibility model.
//!
//! # Architecture
//!
//! This is a core domain entity. It knows nothing about rendering, engine
//! masks, or overlay tiles. The adapter layer projects visibility state
//! into render-ready data.
//!
//! # Lifecycle
//!
//! - Created when a play session starts.
//! - Updated each tick based on observer positions and vision ranges.
//! - Destroyed when the session stops (edit mode has no fog).

use std::collections::{HashMap, HashSet};
use super::types::TeamId;
use crate::entities::freedom_board::coords::{CHUNK_SIZE, TileCoord, ChunkCoord};

/// Visibility state of a single cell for one team.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellState {
    /// Never seen. Entities here are not rendered or interactable.
    Hidden,
    /// Previously seen but no longer in any observer's range. Dimmed.
    /// Static terrain visible; actors hidden.
    Explored,
    /// Currently within an observer's vision range. Fully visible.
    Visible,
}

impl Default for CellState {
    fn default() -> Self {
        CellState::Hidden
    }
}

/// Per-chunk visibility data. Flat array of CHUNK_SIZE² cells.
#[derive(Debug, Clone)]
struct VisibilityChunk {
    cells: Vec<CellState>,
}

impl VisibilityChunk {
    fn new() -> Self {
        Self {
            cells: vec![CellState::Hidden; (CHUNK_SIZE * CHUNK_SIZE) as usize],
        }
    }

    fn get(&self, local_x: i32, local_y: i32) -> CellState {
        self.cells[(local_y * CHUNK_SIZE + local_x) as usize]
    }

    fn set(&mut self, local_x: i32, local_y: i32, state: CellState) {
        self.cells[(local_y * CHUNK_SIZE + local_x) as usize] = state;
    }

    /// Returns true if every cell is Hidden (chunk can be pruned).
    fn is_all_hidden(&self) -> bool {
        self.cells.iter().all(|c| *c == CellState::Hidden)
    }
}

/// Per-team sparse visibility grid.
///
/// Chunks are created on demand when cells within them become non-Hidden.
/// Untracked chunks (not in the map) are implicitly Hidden.
#[derive(Debug, Clone)]
pub struct TeamVisibility {
    /// Team this visibility belongs to.
    pub team_id: TeamId,
    /// Sparse chunk storage. Only chunks with non-Hidden cells are stored.
    chunks: HashMap<ChunkCoord, VisibilityChunk>,
    /// Set of cells that were Visible on the previous update.
    /// Used for efficient demotion (Visible→Explored) without scanning all chunks.
    previously_visible: HashSet<TileCoord>,
}

impl TeamVisibility {
    /// Create a new empty visibility (all cells implicitly Hidden).
    pub fn new(team_id: TeamId) -> Self {
        Self {
            team_id,
            chunks: HashMap::new(),
            previously_visible: HashSet::new(),
        }
    }

    /// Get the cell state at world tile coordinates.
    /// Returns Hidden for untracked chunks.
    pub fn get_world(&self, tile_x: i32, tile_y: i32) -> CellState {
        let cc = TileCoord::new(tile_x, tile_y).chunk();
        let (lx, ly) = TileCoord::new(tile_x, tile_y).local();
        match self.chunks.get(&cc) {
            Some(chunk) => chunk.get(lx as i32, ly as i32),
            None => CellState::Hidden,
        }
    }

    /// Set a cell at world tile coordinates.
    /// Creates the chunk on demand if the state is non-Hidden.
    pub fn set_world(&mut self, tile_x: i32, tile_y: i32, state: CellState) {
        let tc = TileCoord::new(tile_x, tile_y);
        let cc = tc.chunk();
        let (lx, ly) = tc.local();

        if state == CellState::Hidden {
            // Don't create chunks just to store Hidden.
            if let Some(chunk) = self.chunks.get_mut(&cc) {
                chunk.set(lx as i32, ly as i32, CellState::Hidden);
            }
        } else {
            let chunk = self.chunks.entry(cc).or_insert_with(VisibilityChunk::new);
            chunk.set(lx as i32, ly as i32, state);
        }
    }

    /// Check if a world tile is currently Visible to this team.
    pub fn is_visible(&self, tile_x: i32, tile_y: i32) -> bool {
        self.get_world(tile_x, tile_y) == CellState::Visible
    }

    /// Check if a world tile has ever been seen (Visible or Explored).
    pub fn is_explored(&self, tile_x: i32, tile_y: i32) -> bool {
        matches!(self.get_world(tile_x, tile_y), CellState::Visible | CellState::Explored)
    }

    /// Reset all cells to Hidden (drop all chunks).
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.previously_visible.clear();
    }

    /// Read-only access to the previously-visible set (for use case algorithm).
    pub fn previously_visible(&self) -> &HashSet<TileCoord> {
        &self.previously_visible
    }

    /// Replace the previously-visible set (called by update_visibility).
    pub fn set_previously_visible(&mut self, visible: HashSet<TileCoord>) {
        self.previously_visible = visible;
    }

    /// Iterate over all chunks that have visibility data.
    /// Returns (ChunkCoord, &cells) for each tracked chunk.
    pub fn chunks(&self) -> impl Iterator<Item = (&ChunkCoord, &[CellState])> {
        self.chunks.iter().map(|(cc, vc)| (cc, vc.cells.as_slice()))
    }

    /// Number of tracked chunks (chunks with any non-Hidden state).
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Prune chunks that are entirely Hidden (optional memory cleanup).
    pub fn prune_empty_chunks(&mut self) {
        self.chunks.retain(|_, chunk| !chunk.is_all_hidden());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_visibility_is_all_hidden() {
        let vis = TeamVisibility::new(TeamId(0));
        assert_eq!(vis.get_world(0, 0), CellState::Hidden);
        assert_eq!(vis.get_world(100, -200), CellState::Hidden);
        assert_eq!(vis.chunk_count(), 0);
    }

    #[test]
    fn set_and_get_world() {
        let mut vis = TeamVisibility::new(TeamId(0));
        vis.set_world(5, 10, CellState::Visible);
        assert_eq!(vis.get_world(5, 10), CellState::Visible);
        assert_eq!(vis.get_world(5, 11), CellState::Hidden);
        assert_eq!(vis.chunk_count(), 1); // one chunk created
    }

    #[test]
    fn negative_coordinates() {
        let mut vis = TeamVisibility::new(TeamId(0));
        vis.set_world(-10, -20, CellState::Explored);
        assert_eq!(vis.get_world(-10, -20), CellState::Explored);
        assert_eq!(vis.get_world(-10, -19), CellState::Hidden);
    }

    #[test]
    fn setting_hidden_does_not_create_chunk() {
        let mut vis = TeamVisibility::new(TeamId(0));
        vis.set_world(100, 100, CellState::Hidden);
        assert_eq!(vis.chunk_count(), 0);
    }

    #[test]
    fn clear_drops_all_chunks() {
        let mut vis = TeamVisibility::new(TeamId(0));
        vis.set_world(0, 0, CellState::Visible);
        vis.set_world(100, 100, CellState::Explored);
        assert_eq!(vis.chunk_count(), 2);
        vis.clear();
        assert_eq!(vis.chunk_count(), 0);
        assert_eq!(vis.get_world(0, 0), CellState::Hidden);
    }

    #[test]
    fn is_visible_and_is_explored() {
        let mut vis = TeamVisibility::new(TeamId(0));
        vis.set_world(1, 1, CellState::Visible);
        vis.set_world(2, 2, CellState::Explored);

        assert!(vis.is_visible(1, 1));
        assert!(!vis.is_visible(2, 2));
        assert!(vis.is_explored(1, 1));
        assert!(vis.is_explored(2, 2));
        assert!(!vis.is_explored(3, 3));
    }

    #[test]
    fn cross_chunk_boundary() {
        let mut vis = TeamVisibility::new(TeamId(0));
        // Tiles at chunk boundary (31 is last tile of chunk 0, 32 is first of chunk 1)
        vis.set_world(31, 0, CellState::Visible);
        vis.set_world(32, 0, CellState::Explored);
        assert_eq!(vis.get_world(31, 0), CellState::Visible);
        assert_eq!(vis.get_world(32, 0), CellState::Explored);
        assert_eq!(vis.chunk_count(), 2); // two different chunks
    }

    #[test]
    fn prune_empty_chunks() {
        let mut vis = TeamVisibility::new(TeamId(0));
        vis.set_world(5, 5, CellState::Visible);
        assert_eq!(vis.chunk_count(), 1);

        // Set back to Hidden
        vis.set_world(5, 5, CellState::Hidden);
        assert_eq!(vis.chunk_count(), 1); // chunk still exists

        vis.prune_empty_chunks();
        assert_eq!(vis.chunk_count(), 0); // now pruned
    }

    #[test]
    fn chunks_iterator() {
        let mut vis = TeamVisibility::new(TeamId(0));
        vis.set_world(0, 0, CellState::Visible);
        vis.set_world(64, 64, CellState::Explored);

        let chunk_coords: Vec<_> = vis.chunks().map(|(cc, _)| *cc).collect();
        assert_eq!(chunk_coords.len(), 2);
    }
}
