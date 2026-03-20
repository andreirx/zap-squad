//! Edit operations on the SparseWorld.
//!
//! Each operation returns `EditResult`(s) that capture the before/after state
//! of affected tiles. These are the undo records — store them for undo/redo.
//!
//! All operations are synchronous and infallible (they always succeed).
//! Validation (e.g., "is this layer valid?") belongs in the caller.

use std::collections::VecDeque;

use crate::entities::freedom_board::{SparseWorld, TileCoord, TilePlacement};

/// The delta produced by a single tile mutation. Invertible for undo.
#[derive(Clone, Debug)]
pub struct EditResult {
    pub coord: TileCoord,
    pub old: Option<TilePlacement>,
    pub new: Option<TilePlacement>,
}

impl EditResult {
    /// Apply this edit's inverse to the world (undo).
    pub fn undo(&self, world: &mut SparseWorld) {
        match self.old {
            Some(tile) => {
                world.set(self.coord, tile);
            }
            None => {
                world.remove(self.coord);
            }
        }
    }

    /// Re-apply this edit to the world (redo).
    pub fn redo(&self, world: &mut SparseWorld) {
        match self.new {
            Some(tile) => {
                world.set(self.coord, tile);
            }
            None => {
                world.remove(self.coord);
            }
        }
    }
}

/// Place a single tile.
pub fn place_tile(
    world: &mut SparseWorld,
    coord: TileCoord,
    tile: TilePlacement,
) -> EditResult {
    let old = world.set(coord, tile);
    EditResult {
        coord,
        old,
        new: Some(tile),
    }
}

/// Remove a single tile.
pub fn erase_tile(world: &mut SparseWorld, coord: TileCoord) -> EditResult {
    let old = world.remove(coord);
    EditResult {
        coord,
        old,
        new: None,
    }
}

/// Fill a rectangular region with a tile.
pub fn fill_rect(
    world: &mut SparseWorld,
    min: TileCoord,
    max: TileCoord,
    tile: TilePlacement,
) -> Vec<EditResult> {
    let mut results = Vec::new();
    for y in min.y..=max.y {
        for x in min.x..=max.x {
            let coord = TileCoord::new(x, y);
            results.push(place_tile(world, coord, tile));
        }
    }
    results
}

/// Erase all tiles in a rectangular region.
pub fn erase_rect(
    world: &mut SparseWorld,
    min: TileCoord,
    max: TileCoord,
) -> Vec<EditResult> {
    let mut results = Vec::new();
    for y in min.y..=max.y {
        for x in min.x..=max.x {
            let coord = TileCoord::new(x, y);
            if world.get(coord).is_some() {
                results.push(erase_tile(world, coord));
            }
        }
    }
    results
}

/// Draw a line of tiles using Bresenham's algorithm.
///
/// Produces a continuous line from `from` to `to` with no gaps,
/// suitable for brush strokes during drag operations.
pub fn draw_line(
    world: &mut SparseWorld,
    from: TileCoord,
    to: TileCoord,
    tile: TilePlacement,
) -> Vec<EditResult> {
    let mut results = Vec::new();

    let mut x0 = from.x;
    let mut y0 = from.y;
    let x1 = to.x;
    let y1 = to.y;

    let dx = (x1 - x0).abs();
    let dy = -(y1 - y0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;

    loop {
        results.push(place_tile(world, TileCoord::new(x0, y0), tile));

        if x0 == x1 && y0 == y1 {
            break;
        }

        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x0 += sx;
        }
        if e2 <= dx {
            err += dx;
            y0 += sy;
        }
    }

    results
}

/// Flood fill from a starting point, replacing tiles that match the original
/// tile at the start position (or empty if start is empty).
///
/// `max_tiles` is a safety limit to prevent runaway fills on large empty regions.
/// Returns early if the limit is reached.
pub fn flood_fill(
    world: &mut SparseWorld,
    start: TileCoord,
    fill_tile: TilePlacement,
    max_tiles: usize,
) -> Vec<EditResult> {
    let target = world.get(start).copied();

    // Don't fill if the start already has the fill tile
    if target.as_ref() == Some(&fill_tile) {
        return Vec::new();
    }

    let mut results = Vec::new();
    let mut queue = VecDeque::new();
    let mut visited = std::collections::HashSet::new();

    queue.push_back(start);
    visited.insert(start);

    while let Some(coord) = queue.pop_front() {
        if results.len() >= max_tiles {
            break;
        }

        // Check if this cell matches the target (what we're replacing)
        let current = world.get(coord).copied();
        if current != target {
            continue;
        }

        // Place the fill tile
        results.push(place_tile(world, coord, fill_tile));

        // Enqueue 4-connected neighbors
        let neighbors = [
            TileCoord::new(coord.x, coord.y - 1),
            TileCoord::new(coord.x + 1, coord.y),
            TileCoord::new(coord.x, coord.y + 1),
            TileCoord::new(coord.x - 1, coord.y),
        ];

        for n in neighbors {
            if visited.insert(n) {
                queue.push_back(n);
            }
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(id: u16) -> TilePlacement {
        TilePlacement::new(id, 0, 0)
    }

    fn tc(x: i32, y: i32) -> TileCoord {
        TileCoord::new(x, y)
    }

    #[test]
    fn place_and_undo() {
        let mut world = SparseWorld::new();
        let edit = place_tile(&mut world, tc(5, 5), tile(42));

        assert_eq!(world.get(tc(5, 5)).unwrap().asset_id, 42);

        edit.undo(&mut world);
        assert!(world.get(tc(5, 5)).is_none());
    }

    #[test]
    fn erase_and_undo() {
        let mut world = SparseWorld::new();
        world.set(tc(3, 3), tile(99));

        let edit = erase_tile(&mut world, tc(3, 3));
        assert!(world.get(tc(3, 3)).is_none());

        edit.undo(&mut world);
        assert_eq!(world.get(tc(3, 3)).unwrap().asset_id, 99);
    }

    #[test]
    fn fill_rect_produces_correct_edits() {
        let mut world = SparseWorld::new();
        let edits = fill_rect(&mut world, tc(0, 0), tc(3, 3), tile(1));

        assert_eq!(edits.len(), 16); // 4x4
        assert_eq!(world.tile_count(), 16);

        // Undo all
        for edit in edits.iter().rev() {
            edit.undo(&mut world);
        }
        assert_eq!(world.tile_count(), 0);
    }

    #[test]
    fn bresenham_line_horizontal() {
        let mut world = SparseWorld::new();
        let edits = draw_line(&mut world, tc(0, 0), tc(5, 0), tile(1));

        assert_eq!(edits.len(), 6); // 0,1,2,3,4,5
        for x in 0..=5 {
            assert!(world.get(tc(x, 0)).is_some());
        }
    }

    #[test]
    fn bresenham_line_diagonal() {
        let mut world = SparseWorld::new();
        let edits = draw_line(&mut world, tc(0, 0), tc(3, 3), tile(1));

        // Diagonal line should hit (0,0), (1,1), (2,2), (3,3)
        assert_eq!(edits.len(), 4);
    }

    #[test]
    fn bresenham_line_single_point() {
        let mut world = SparseWorld::new();
        let edits = draw_line(&mut world, tc(5, 5), tc(5, 5), tile(1));
        assert_eq!(edits.len(), 1);
    }

    #[test]
    fn flood_fill_empty_region() {
        let mut world = SparseWorld::new();
        // Fill from empty start — should fill neighboring empties
        let edits = flood_fill(&mut world, tc(0, 0), tile(1), 100);

        // With max_tiles=100, it fills 100 tiles from the origin outward
        assert_eq!(edits.len(), 100);
    }

    #[test]
    fn flood_fill_bounded_region() {
        let mut world = SparseWorld::new();

        // Create a 5x5 enclosed area with walls (tile 2) and empty interior
        for x in 0..=4 {
            world.set(tc(x, 0), tile(2)); // top wall
            world.set(tc(x, 4), tile(2)); // bottom wall
        }
        for y in 0..=4 {
            world.set(tc(0, y), tile(2)); // left wall
            world.set(tc(4, y), tile(2)); // right wall
        }

        // Fill the interior (3x3 = 9 empty cells)
        let edits = flood_fill(&mut world, tc(2, 2), tile(3), 1000);
        assert_eq!(edits.len(), 9);

        // Verify walls are untouched
        assert_eq!(world.get(tc(0, 0)).unwrap().asset_id, 2);
        assert_eq!(world.get(tc(4, 4)).unwrap().asset_id, 2);

        // Verify interior is filled
        assert_eq!(world.get(tc(2, 2)).unwrap().asset_id, 3);
        assert_eq!(world.get(tc(1, 1)).unwrap().asset_id, 3);
    }

    #[test]
    fn flood_fill_noop_when_same_tile() {
        let mut world = SparseWorld::new();
        world.set(tc(0, 0), tile(1));

        let edits = flood_fill(&mut world, tc(0, 0), tile(1), 100);
        assert!(edits.is_empty()); // already the fill tile
    }

    #[test]
    fn erase_rect() {
        let mut world = SparseWorld::new();
        for x in 0..5 {
            for y in 0..5 {
                world.set(tc(x, y), tile(1));
            }
        }
        assert_eq!(world.tile_count(), 25);

        let edits = super::erase_rect(&mut world, tc(1, 1), tc(3, 3));
        assert_eq!(edits.len(), 9); // 3x3 interior
        assert_eq!(world.tile_count(), 16); // 25 - 9
    }
}
