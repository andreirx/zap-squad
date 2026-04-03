//! Visibility update — recompute which cells a team can see.
//!
//! Operates on sparse chunked `TeamVisibility`. Instead of sweeping the
//! entire grid, only touches:
//! 1. Cells that were previously Visible (demote to Explored)
//! 2. Cells within each observer's radius (promote to Visible)
//!
//! # Radius model
//!
//! Phase 1: Euclidean distance (circular vision). No line-of-sight occlusion.

use std::collections::HashSet;
use crate::entities::game_rules::{TeamVisibility, CellState};

/// An entity that provides vision — position in world tile coords + range.
pub struct Observer {
    /// World tile X (integer — the tile the observer stands on).
    pub tile_x: i32,
    /// World tile Y.
    pub tile_y: i32,
    /// Vision radius in tiles. Cells within this Euclidean distance become Visible.
    pub range: u32,
}

/// Update visibility for one team based on its current observers.
///
/// Algorithm (sparse-aware):
/// 1. Demote all previously-Visible cells to Explored (using the tracked set).
/// 2. For each observer, compute the set of cells within radius and mark Visible.
/// 3. Store the new Visible set for next frame's demotion pass.
///
/// Only touches cells that change state — does not scan the entire world.
pub fn update_visibility(vis: &mut TeamVisibility, observers: &[Observer]) {
    // Step 1: Demote previously-visible cells to Explored.
    let prev_visible: HashSet<_> = vis.previously_visible().clone();
    for tc in &prev_visible {
        // Only demote if still Visible (might have been manually changed).
        if vis.get_world(tc.x, tc.y) == CellState::Visible {
            vis.set_world(tc.x, tc.y, CellState::Explored);
        }
    }

    // Step 2: Compute new Visible set from all observers.
    let mut new_visible = HashSet::new();
    for obs in observers {
        let range_sq = (obs.range as i64) * (obs.range as i64);
        let r = obs.range as i32;

        for dy in -r..=r {
            for dx in -r..=r {
                let dist_sq = (dx as i64) * (dx as i64) + (dy as i64) * (dy as i64);
                if dist_sq <= range_sq {
                    let tx = obs.tile_x + dx;
                    let ty = obs.tile_y + dy;
                    vis.set_world(tx, ty, CellState::Visible);
                    new_visible.insert(crate::entities::freedom_board::coords::TileCoord::new(tx, ty));
                }
            }
        }
    }

    // Step 3: Store new visible set for next frame's demotion.
    vis.set_previously_visible(new_visible);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::game_rules::TeamId;

    #[test]
    fn single_observer_reveals_circle() {
        let mut vis = TeamVisibility::new(TeamId(0));
        let observers = vec![Observer { tile_x: 10, tile_y: 10, range: 3 }];

        update_visibility(&mut vis, &observers);

        assert_eq!(vis.get_world(10, 10), CellState::Visible);
        assert_eq!(vis.get_world(10, 13), CellState::Visible);
        assert_eq!(vis.get_world(13, 10), CellState::Visible);
        // Outside range
        assert_eq!(vis.get_world(10, 14), CellState::Hidden);
        assert_eq!(vis.get_world(14, 10), CellState::Hidden);
        // Diagonal: sqrt(3²+3²) ≈ 4.24 > 3
        assert_eq!(vis.get_world(13, 13), CellState::Hidden);
        // sqrt(2²+2²) ≈ 2.83 ≤ 3
        assert_eq!(vis.get_world(12, 12), CellState::Visible);
    }

    #[test]
    fn visible_demotes_to_explored_when_observer_moves() {
        let mut vis = TeamVisibility::new(TeamId(0));

        update_visibility(&mut vis, &[Observer { tile_x: 5, tile_y: 5, range: 2 }]);
        assert_eq!(vis.get_world(5, 5), CellState::Visible);

        update_visibility(&mut vis, &[Observer { tile_x: 15, tile_y: 15, range: 2 }]);
        assert_eq!(vis.get_world(5, 5), CellState::Explored);
        assert_eq!(vis.get_world(15, 15), CellState::Visible);
    }

    #[test]
    fn hidden_never_becomes_explored_directly() {
        let mut vis = TeamVisibility::new(TeamId(0));

        update_visibility(&mut vis, &[Observer { tile_x: 2, tile_y: 2, range: 1 }]);

        assert_eq!(vis.get_world(0, 0), CellState::Hidden);
        assert_eq!(vis.get_world(2, 2), CellState::Visible);
    }

    #[test]
    fn no_observers_demotes_all_visible() {
        let mut vis = TeamVisibility::new(TeamId(0));

        update_visibility(&mut vis, &[Observer { tile_x: 5, tile_y: 5, range: 2 }]);
        assert_eq!(vis.get_world(5, 5), CellState::Visible);

        update_visibility(&mut vis, &[]);
        assert_eq!(vis.get_world(5, 5), CellState::Explored);
    }

    #[test]
    fn multiple_observers_union() {
        let mut vis = TeamVisibility::new(TeamId(0));
        let observers = vec![
            Observer { tile_x: 3, tile_y: 3, range: 2 },
            Observer { tile_x: 10, tile_y: 10, range: 2 },
        ];

        update_visibility(&mut vis, &observers);

        assert_eq!(vis.get_world(3, 3), CellState::Visible);
        assert_eq!(vis.get_world(10, 10), CellState::Visible);
        assert_eq!(vis.get_world(7, 7), CellState::Hidden);
    }

    #[test]
    fn overlapping_observers() {
        let mut vis = TeamVisibility::new(TeamId(0));
        let observers = vec![
            Observer { tile_x: 4, tile_y: 5, range: 3 },
            Observer { tile_x: 6, tile_y: 5, range: 3 },
        ];

        update_visibility(&mut vis, &observers);
        assert_eq!(vis.get_world(5, 5), CellState::Visible);
    }

    #[test]
    fn negative_coordinates() {
        let mut vis = TeamVisibility::new(TeamId(0));
        let observers = vec![Observer { tile_x: -5, tile_y: -5, range: 2 }];

        update_visibility(&mut vis, &observers);

        assert_eq!(vis.get_world(-5, -5), CellState::Visible);
        assert_eq!(vis.get_world(-3, -5), CellState::Visible);
        assert_eq!(vis.get_world(0, 0), CellState::Hidden);
    }

    #[test]
    fn zero_range_observer_reveals_only_own_cell() {
        let mut vis = TeamVisibility::new(TeamId(0));
        let observers = vec![Observer { tile_x: 5, tile_y: 5, range: 0 }];

        update_visibility(&mut vis, &observers);

        assert_eq!(vis.get_world(5, 5), CellState::Visible);
        assert_eq!(vis.get_world(5, 6), CellState::Hidden);
    }

    #[test]
    fn sparse_storage_only_creates_needed_chunks() {
        let mut vis = TeamVisibility::new(TeamId(0));
        let observers = vec![Observer { tile_x: 5, tile_y: 5, range: 2 }];

        update_visibility(&mut vis, &observers);

        // Observer at (5,5) range 2 affects tiles (3..7, 3..7) — all in chunk (0,0)
        assert_eq!(vis.chunk_count(), 1);
    }

    #[test]
    fn cross_chunk_boundary_observation() {
        let mut vis = TeamVisibility::new(TeamId(0));
        // Observer at chunk boundary
        let observers = vec![Observer { tile_x: 31, tile_y: 0, range: 3 }];

        update_visibility(&mut vis, &observers);

        // Should see into both chunk (0,0) and chunk (1,0)
        assert_eq!(vis.get_world(31, 0), CellState::Visible);
        assert_eq!(vis.get_world(32, 0), CellState::Visible);
        assert!(vis.chunk_count() >= 2);
    }

    #[test]
    fn demotion_is_efficient() {
        let mut vis = TeamVisibility::new(TeamId(0));

        // Reveal a small area
        update_visibility(&mut vis, &[Observer { tile_x: 0, tile_y: 0, range: 1 }]);
        let visible_count = vis.previously_visible().len();
        assert!(visible_count > 0 && visible_count <= 5); // circle of radius 1

        // Move observer far away — only the previous visible set needs demotion
        update_visibility(&mut vis, &[Observer { tile_x: 1000, tile_y: 1000, range: 1 }]);
        assert_eq!(vis.get_world(0, 0), CellState::Explored);
        assert_eq!(vis.get_world(1000, 1000), CellState::Visible);
    }
}
