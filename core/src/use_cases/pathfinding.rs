//! A* Pathfinding use case
//!
//! Pure pathfinding logic with no framework dependencies.

use glam::IVec2;
use std::collections::{BinaryHeap, HashMap};
use std::cmp::Ordering;

/// Navigation grid abstraction
pub trait NavGrid {
    fn is_walkable(&self, x: i32, y: i32) -> bool;
    fn width(&self) -> i32;
    fn height(&self) -> i32;
}

/// Result of pathfinding
pub type PathResult = Option<Vec<IVec2>>;

/// Node for A* priority queue
#[derive(Clone, Eq, PartialEq)]
struct Node {
    pos: IVec2,
    cost: i32,
    priority: i32,
}

impl Ord for Node {
    fn cmp(&self, other: &Self) -> Ordering {
        other.priority.cmp(&self.priority) // Reverse for min-heap
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Heuristic: Chebyshev distance (allows diagonal movement)
fn heuristic(a: IVec2, b: IVec2) -> i32 {
    let dx = (a.x - b.x).abs();
    let dy = (a.y - b.y).abs();
    dx.max(dy)
}

/// 8-directional neighbors
const DIRECTIONS: [(i32, i32); 8] = [
    (-1, -1), (0, -1), (1, -1),
    (-1, 0),           (1, 0),
    (-1, 1),  (0, 1),  (1, 1),
];

/// Find path using A* algorithm
///
/// Returns a list of grid positions from start to goal (exclusive of start).
pub fn find_path(grid: &impl NavGrid, start: IVec2, goal: IVec2) -> PathResult {
    if !grid.is_walkable(goal.x, goal.y) {
        return None;
    }

    let mut open = BinaryHeap::new();
    let mut came_from: HashMap<IVec2, IVec2> = HashMap::new();
    let mut g_score: HashMap<IVec2, i32> = HashMap::new();

    g_score.insert(start, 0);
    open.push(Node {
        pos: start,
        cost: 0,
        priority: heuristic(start, goal),
    });

    while let Some(current) = open.pop() {
        if current.pos == goal {
            // Reconstruct path
            let mut path = vec![goal];
            let mut curr = goal;
            while let Some(&prev) = came_from.get(&curr) {
                if prev == start {
                    break;
                }
                path.push(prev);
                curr = prev;
            }
            path.reverse();
            return Some(path);
        }

        let current_g = *g_score.get(&current.pos).unwrap_or(&i32::MAX);

        for (dx, dy) in DIRECTIONS {
            let neighbor = IVec2::new(current.pos.x + dx, current.pos.y + dy);

            // Bounds check
            if neighbor.x < 0 || neighbor.y < 0
                || neighbor.x >= grid.width()
                || neighbor.y >= grid.height()
            {
                continue;
            }

            if !grid.is_walkable(neighbor.x, neighbor.y) {
                continue;
            }

            // Diagonal movement costs sqrt(2) ≈ 14, straight costs 10
            let move_cost = if dx != 0 && dy != 0 { 14 } else { 10 };
            let tentative_g = current_g + move_cost;

            if tentative_g < *g_score.get(&neighbor).unwrap_or(&i32::MAX) {
                came_from.insert(neighbor, current.pos);
                g_score.insert(neighbor, tentative_g);
                open.push(Node {
                    pos: neighbor,
                    cost: tentative_g,
                    priority: tentative_g + heuristic(neighbor, goal) * 10,
                });
            }
        }
    }

    None // No path found
}

/// Navigation grid for infinite/unbounded worlds.
///
/// Unlike `NavGrid`, this trait does not require width/height bounds.
/// The pathfinder limits search with a radius parameter instead.
pub trait InfiniteNavGrid {
    fn is_walkable(&self, x: i32, y: i32) -> bool;

    /// Movement cost for entering this tile (1-255). Higher = harder to traverse.
    /// Default implementation returns 10 for all walkable tiles.
    /// Override to make paths (5) cheaper than terrain (10) and difficult tiles (20+) costlier.
    fn movement_cost(&self, x: i32, y: i32) -> i32 {
        if self.is_walkable(x, y) { 10 } else { i32::MAX }
    }
}

/// A* pathfinding on an unbounded grid, limited by search radius.
///
/// The search explores a square region of `(2*max_radius+1)^2` tiles
/// centered on `start`. This prevents infinite exploration when no
/// path exists.
///
/// Uses the same 8-directional movement and Chebyshev heuristic as `find_path`.
pub fn find_path_in_radius(
    grid: &impl InfiniteNavGrid,
    start: IVec2,
    goal: IVec2,
    max_radius: i32,
) -> PathResult {
    // Quick reject: goal outside search radius
    if (goal.x - start.x).abs() > max_radius || (goal.y - start.y).abs() > max_radius {
        return None;
    }

    if !grid.is_walkable(goal.x, goal.y) {
        return None;
    }

    let mut open = BinaryHeap::new();
    let mut came_from: HashMap<IVec2, IVec2> = HashMap::new();
    let mut g_score: HashMap<IVec2, i32> = HashMap::new();

    g_score.insert(start, 0);
    open.push(Node {
        pos: start,
        cost: 0,
        priority: heuristic(start, goal),
    });

    while let Some(current) = open.pop() {
        if current.pos == goal {
            let mut path = vec![goal];
            let mut curr = goal;
            while let Some(&prev) = came_from.get(&curr) {
                if prev == start {
                    break;
                }
                path.push(prev);
                curr = prev;
            }
            path.reverse();
            return Some(path);
        }

        let current_g = *g_score.get(&current.pos).unwrap_or(&i32::MAX);

        for (dx, dy) in DIRECTIONS {
            let neighbor = IVec2::new(current.pos.x + dx, current.pos.y + dy);

            // Radius bounds check (replaces width/height check)
            if (neighbor.x - start.x).abs() > max_radius
                || (neighbor.y - start.y).abs() > max_radius
            {
                continue;
            }

            if !grid.is_walkable(neighbor.x, neighbor.y) {
                continue;
            }

            // Scale tile cost by 10 for integer precision, then apply diagonal multiplier.
            // This ensures cost=1 tiles still distinguish straight (10) from diagonal (14).
            let tile_cost = grid.movement_cost(neighbor.x, neighbor.y) * 10;
            let move_cost = if dx != 0 && dy != 0 {
                tile_cost * 14 / 10  // ~1.4x for diagonal
            } else {
                tile_cost            // straight
            };
            let tentative_g = current_g + move_cost;

            if tentative_g < *g_score.get(&neighbor).unwrap_or(&i32::MAX) {
                came_from.insert(neighbor, current.pos);
                g_score.insert(neighbor, tentative_g);
                open.push(Node {
                    pos: neighbor,
                    cost: tentative_g,
                    priority: tentative_g + heuristic(neighbor, goal) * 10,
                });
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestGrid {
        width: i32,
        height: i32,
        blocked: Vec<IVec2>,
    }

    impl NavGrid for TestGrid {
        fn is_walkable(&self, x: i32, y: i32) -> bool {
            !self.blocked.contains(&IVec2::new(x, y))
        }
        fn width(&self) -> i32 { self.width }
        fn height(&self) -> i32 { self.height }
    }

    #[test]
    fn direct_path() {
        let grid = TestGrid { width: 10, height: 10, blocked: vec![] };
        let path = find_path(&grid, IVec2::new(0, 0), IVec2::new(3, 0));

        assert!(path.is_some());
        let path = path.unwrap();
        assert_eq!(*path.last().unwrap(), IVec2::new(3, 0));
    }

    #[test]
    fn path_around_obstacle() {
        let grid = TestGrid {
            width: 5,
            height: 5,
            blocked: vec![IVec2::new(2, 1), IVec2::new(2, 2), IVec2::new(2, 3)],
        };
        let path = find_path(&grid, IVec2::new(0, 2), IVec2::new(4, 2));

        assert!(path.is_some());
        let path = path.unwrap();
        // Should go around the wall
        assert!(!path.contains(&IVec2::new(2, 2)));
        assert_eq!(*path.last().unwrap(), IVec2::new(4, 2));
    }

    #[test]
    fn no_path_blocked_goal() {
        let grid = TestGrid {
            width: 5,
            height: 5,
            blocked: vec![IVec2::new(3, 3)],
        };
        let path = find_path(&grid, IVec2::new(0, 0), IVec2::new(3, 3));
        assert!(path.is_none());
    }

    // ── InfiniteNavGrid tests ────────────────────────────────────────

    struct InfiniteTestGrid {
        blocked: Vec<IVec2>,
    }

    impl InfiniteNavGrid for InfiniteTestGrid {
        fn is_walkable(&self, x: i32, y: i32) -> bool {
            !self.blocked.contains(&IVec2::new(x, y))
        }
    }

    #[test]
    fn infinite_direct_path() {
        let grid = InfiniteTestGrid { blocked: vec![] };
        let path = find_path_in_radius(&grid, IVec2::new(100, 200), IVec2::new(103, 200), 50);
        assert!(path.is_some());
        let path = path.unwrap();
        assert_eq!(*path.last().unwrap(), IVec2::new(103, 200));
    }

    #[test]
    fn infinite_negative_coords() {
        let grid = InfiniteTestGrid { blocked: vec![] };
        let path = find_path_in_radius(&grid, IVec2::new(-10, -10), IVec2::new(-5, -5), 20);
        assert!(path.is_some());
        assert_eq!(*path.unwrap().last().unwrap(), IVec2::new(-5, -5));
    }

    #[test]
    fn infinite_path_around_obstacle() {
        let grid = InfiniteTestGrid {
            blocked: vec![IVec2::new(2, 1), IVec2::new(2, 2), IVec2::new(2, 3)],
        };
        let path = find_path_in_radius(&grid, IVec2::new(0, 2), IVec2::new(4, 2), 20);
        assert!(path.is_some());
        assert!(!path.as_ref().unwrap().contains(&IVec2::new(2, 2)));
    }

    #[test]
    fn infinite_goal_outside_radius() {
        let grid = InfiniteTestGrid { blocked: vec![] };
        let path = find_path_in_radius(&grid, IVec2::new(0, 0), IVec2::new(100, 0), 10);
        assert!(path.is_none()); // goal beyond search radius
    }

    #[test]
    fn infinite_blocked_goal() {
        let grid = InfiniteTestGrid {
            blocked: vec![IVec2::new(5, 5)],
        };
        let path = find_path_in_radius(&grid, IVec2::new(0, 0), IVec2::new(5, 5), 20);
        assert!(path.is_none());
    }
}
