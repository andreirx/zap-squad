//! Quadtree spatial index over chunk coordinates.
//!
//! Provides efficient range queries and level-of-detail (LOD) aggregation
//! for the SparseWorld. Indexes only non-empty chunks.
//!
//! # Design
//!
//! The tree stores point data (ChunkCoords), not regions. Each node covers
//! a square region of chunk-space. The tree grows dynamically when chunks
//! are inserted outside the current root bounds — no fixed world size.
//!
//! Internal nodes cache aggregate data (tile counts, dominant colors) for
//! LOD rendering. At far zoom levels, the renderer can draw a single colored
//! quad per quadtree node instead of individual tiles, giving adaptive detail.
//!
//! # Complexity
//!
//! - Insert: O(log N) where N = tree depth (bounded by coordinate range)
//! - Remove: O(log N)
//! - Range query: O(k + log N) where k = results
//! - LOD query: O(nodes visited), pruned by viewport

use super::chunk::ChunkLOD;
use super::coords::{ChunkCoord, CHUNK_AREA};

// ── Axis-Aligned Bounding Box ──────────────────────────────────────────────

/// Half-open rectangle `[min_x, max_x) x [min_y, max_y)` in chunk coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkAABB {
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
}

impl ChunkAABB {
    pub const fn new(min_x: i32, min_y: i32, max_x: i32, max_y: i32) -> Self {
        Self {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }

    /// Square region starting at (x, y) with side length `size`.
    const fn from_square(x: i32, y: i32, size: i32) -> Self {
        Self {
            min_x: x,
            min_y: y,
            max_x: x + size,
            max_y: y + size,
        }
    }

    pub fn contains(&self, coord: ChunkCoord) -> bool {
        coord.x >= self.min_x
            && coord.x < self.max_x
            && coord.y >= self.min_y
            && coord.y < self.max_y
    }

    pub fn intersects(&self, other: &ChunkAABB) -> bool {
        self.min_x < other.max_x
            && self.max_x > other.min_x
            && self.min_y < other.max_y
            && self.max_y > other.min_y
    }

    pub fn width(&self) -> i32 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> i32 {
        self.max_y - self.min_y
    }

    /// Side length (assumes square).
    fn size(&self) -> i32 {
        self.width()
    }

    fn mid_x(&self) -> i32 {
        self.min_x + self.width() / 2
    }

    fn mid_y(&self) -> i32 {
        self.min_y + self.height() / 2
    }

    /// Quadrant index for a coordinate: 0=NW, 1=NE, 2=SW, 3=SE.
    fn quadrant_of(&self, coord: ChunkCoord) -> usize {
        let east = coord.x >= self.mid_x();
        let south = coord.y >= self.mid_y();
        (south as usize) * 2 + (east as usize)
    }

    /// Bounds of the specified quadrant.
    fn quadrant_bounds(&self, q: usize) -> ChunkAABB {
        let mx = self.mid_x();
        let my = self.mid_y();
        match q {
            0 => ChunkAABB::new(self.min_x, self.min_y, mx, my), // NW
            1 => ChunkAABB::new(mx, self.min_y, self.max_x, my), // NE
            2 => ChunkAABB::new(self.min_x, my, mx, self.max_y), // SW
            3 => ChunkAABB::new(mx, my, self.max_x, self.max_y), // SE
            _ => unreachable!(),
        }
    }
}

// ── Aggregate ──────────────────────────────────────────────────────────────

/// Aggregated data for a quadtree node, used for LOD rendering.
#[derive(Clone, Copy, Debug, Default)]
pub struct NodeAggregate {
    pub chunk_count: u32,
    pub tile_count: u64,
    pub dominant_color: [u8; 4],
    pub density: f32,
}

impl NodeAggregate {
    fn from_leaf(lod: &ChunkLOD, tile_count: u16) -> Self {
        Self {
            chunk_count: 1,
            tile_count: tile_count as u64,
            dominant_color: lod.dominant_color,
            density: lod.density,
        }
    }

    fn merge_children(children: &[Option<Box<QuadNode>>; 4]) -> Self {
        let mut result = Self::default();
        let mut color_sum = [0u64; 4];
        let mut total_weight = 0u64;

        for child in children.iter().flatten() {
            let agg = &child.aggregate;
            result.chunk_count += agg.chunk_count;
            result.tile_count += agg.tile_count;

            let w = agg.tile_count.max(1);
            for i in 0..4 {
                color_sum[i] += agg.dominant_color[i] as u64 * w;
            }
            total_weight += w;
        }

        if total_weight > 0 {
            for i in 0..4 {
                result.dominant_color[i] = (color_sum[i] / total_weight) as u8;
            }
        }

        if result.chunk_count > 0 {
            result.density =
                result.tile_count as f32 / (result.chunk_count as f32 * CHUNK_AREA as f32);
        }

        result
    }
}

// ── LOD Result ─────────────────────────────────────────────────────────────

/// Debug visualization data for a single quadtree node.
///
/// Used by the rendering layer to draw quadtree boundaries during development.
/// Read-only diagnostic — does not affect tree behavior.
#[derive(Clone, Debug)]
pub struct QuadDebugNode {
    pub bounds: ChunkAABB,
    pub depth: u32,
    pub chunk_count: u32,
    pub is_leaf: bool,
}

/// Result of an adaptive LOD query.
pub enum LODResult {
    /// Render individual tiles from this chunk (close zoom).
    Detail(ChunkCoord),
    /// Render a single colored quad for this region (far zoom).
    Aggregate {
        bounds: ChunkAABB,
        color: [u8; 4],
        density: f32,
    },
}

// ── QuadNode ───────────────────────────────────────────────────────────────

struct QuadNode {
    bounds: ChunkAABB,
    content: NodeContent,
    aggregate: NodeAggregate,
}

enum NodeContent {
    Leaf {
        coord: ChunkCoord,
        lod: ChunkLOD,
        tile_count: u16,
    },
    Branch {
        children: Box<[Option<Box<QuadNode>>; 4]>,
    },
}

impl QuadNode {
    fn new_leaf(coord: ChunkCoord, lod: ChunkLOD, tile_count: u16, bounds: ChunkAABB) -> Self {
        Self {
            bounds,
            aggregate: NodeAggregate::from_leaf(&lod, tile_count),
            content: NodeContent::Leaf {
                coord,
                lod,
                tile_count,
            },
        }
    }

    fn recompute_aggregate(&mut self) {
        match &self.content {
            NodeContent::Leaf {
                lod, tile_count, ..
            } => {
                self.aggregate = NodeAggregate::from_leaf(lod, *tile_count);
            }
            NodeContent::Branch { children } => {
                self.aggregate = NodeAggregate::merge_children(children);
            }
        }
    }
}

// ── QuadTreeIndex ──────────────────────────────────────────────────────────

/// Spatial index over chunk coordinates with LOD aggregation.
///
/// The tree grows dynamically to accommodate any coordinate. Empty after
/// construction; the first `insert` establishes the initial bounds.
pub struct QuadTreeIndex {
    root: Option<QuadNode>,
    count: usize,
}

impl QuadTreeIndex {
    pub fn new() -> Self {
        Self {
            root: None,
            count: 0,
        }
    }

    /// Number of indexed chunks.
    pub fn count(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Insert or update a chunk in the index.
    ///
    /// If the chunk already exists, its LOD data is updated.
    /// If it's new, the tree grows if necessary to contain the coordinate.
    pub fn insert(&mut self, coord: ChunkCoord, lod: ChunkLOD, tile_count: u16) {
        if self.root.is_none() {
            self.root = Some(QuadNode::new_leaf(
                coord,
                lod,
                tile_count,
                ChunkAABB::from_square(coord.x, coord.y, 1),
            ));
            self.count = 1;
            return;
        }

        // Grow tree until root contains coord
        self.grow_to_contain(coord);

        // Insert into tree
        let root = self.root.as_mut().unwrap();
        if Self::insert_into(root, coord, lod, tile_count) {
            self.count += 1;
        }
    }

    /// Remove a chunk from the index. Returns true if it existed.
    pub fn remove(&mut self, coord: ChunkCoord) -> bool {
        let Some(root) = &mut self.root else {
            return false;
        };

        let removed = Self::remove_from(root, coord);
        if removed {
            self.count -= 1;
            if self.count == 0 {
                self.root = None;
            }
        }
        removed
    }

    /// Update LOD data for an existing chunk. No-op if not found.
    pub fn update_lod(&mut self, coord: ChunkCoord, lod: ChunkLOD, tile_count: u16) {
        if let Some(root) = &mut self.root {
            Self::update_in(root, coord, lod, tile_count);
        }
    }

    /// Find all indexed chunk coordinates within a rectangle.
    pub fn query_rect(&self, rect: &ChunkAABB) -> Vec<ChunkCoord> {
        let mut result = Vec::new();
        if let Some(root) = &self.root {
            Self::collect_rect(root, rect, &mut result);
        }
        result
    }

    /// Collect debug visualization data for all nodes in the tree.
    ///
    /// Returns every node's bounds, depth, and occupancy. For rendering
    /// quadtree boundaries during development.
    pub fn debug_nodes(&self) -> Vec<QuadDebugNode> {
        let mut result = Vec::new();
        if let Some(root) = &self.root {
            Self::collect_debug_nodes(root, 0, &mut result);
        }
        result
    }

    fn collect_debug_nodes(node: &QuadNode, depth: u32, result: &mut Vec<QuadDebugNode>) {
        result.push(QuadDebugNode {
            bounds: node.bounds,
            depth,
            chunk_count: node.aggregate.chunk_count,
            is_leaf: matches!(node.content, NodeContent::Leaf { .. }),
        });
        if let NodeContent::Branch { children } = &node.content {
            for child in children.iter().flatten() {
                Self::collect_debug_nodes(child, depth + 1, result);
            }
        }
    }

    /// Adaptive LOD query: returns either individual chunk coords (for close zoom)
    /// or aggregate colored regions (for far zoom).
    ///
    /// - `viewport`: visible area in chunk coordinates.
    /// - `pixels_per_chunk`: how many screen pixels one chunk side occupies at current zoom.
    /// - `detail_threshold`: if a node's screen size is below this, render as aggregate.
    pub fn query_lod(
        &self,
        viewport: &ChunkAABB,
        pixels_per_chunk: f32,
        detail_threshold: f32,
    ) -> Vec<LODResult> {
        let mut result = Vec::new();
        if let Some(root) = &self.root {
            Self::collect_lod(root, viewport, pixels_per_chunk, detail_threshold, &mut result);
        }
        result
    }

    // ── Internal: growth ───────────────────────────────────────────────────

    /// Repeatedly double the root bounds until `target` is contained.
    ///
    /// Each growth wraps the old root as one quadrant of a new, larger root.
    /// The old root is placed in the quadrant opposite to where the target lies,
    /// so the tree expands toward the target.
    fn grow_to_contain(&mut self, target: ChunkCoord) {
        while !self.root.as_ref().unwrap().bounds.contains(target) {
            let old_root = self.root.take().unwrap();
            let b = old_root.bounds;
            let s = b.size().max(1);

            // Which direction is the target relative to current bounds?
            let go_left = target.x < b.min_x;
            let go_up = target.y < b.min_y;

            // New root's bounds and which quadrant the old root occupies.
            // The old root must exactly match one quadrant of the new root.
            let (new_bounds, old_quadrant) = match (go_left, go_up) {
                (false, false) => (ChunkAABB::from_square(b.min_x, b.min_y, s * 2), 0), // old=NW
                (true, false) => (ChunkAABB::from_square(b.min_x - s, b.min_y, s * 2), 1), // old=NE
                (false, true) => (ChunkAABB::from_square(b.min_x, b.min_y - s, s * 2), 2), // old=SW
                (true, true) => (ChunkAABB::from_square(b.min_x - s, b.min_y - s, s * 2), 3), // old=SE
            };

            let old_aggregate = old_root.aggregate;
            let mut children: [Option<Box<QuadNode>>; 4] = [None, None, None, None];
            children[old_quadrant] = Some(Box::new(old_root));

            self.root = Some(QuadNode {
                bounds: new_bounds,
                content: NodeContent::Branch {
                    children: Box::new(children),
                },
                aggregate: old_aggregate,
            });
        }
    }

    // ── Internal: insert ───────────────────────────────────────────────────

    /// Insert into a subtree. Returns `true` if a new entry was created (not an update).
    fn insert_into(
        node: &mut QuadNode,
        coord: ChunkCoord,
        lod: ChunkLOD,
        tile_count: u16,
    ) -> bool {
        let bounds = node.bounds;

        let added = match &mut node.content {
            NodeContent::Leaf {
                coord: existing,
                lod: existing_lod,
                tile_count: existing_count,
            } => {
                if *existing == coord {
                    // Update existing entry
                    *existing_lod = lod;
                    *existing_count = tile_count;
                    false
                } else {
                    // Must split: two different coords in the same node.
                    // Convert this leaf to a branch containing both points.
                    debug_assert!(
                        bounds.size() > 1,
                        "two different coords in a 1x1 region: {:?} vs {:?}",
                        existing,
                        coord
                    );

                    let existing_coord = *existing;
                    let existing_lod = *existing_lod;
                    let existing_count = *existing_count;

                    // Promote to branch
                    let mut children: [Option<Box<QuadNode>>; 4] = [None, None, None, None];

                    // Re-insert the existing leaf
                    let eq = bounds.quadrant_of(existing_coord);
                    let eq_bounds = bounds.quadrant_bounds(eq);
                    children[eq] = Some(Box::new(QuadNode::new_leaf(
                        existing_coord,
                        existing_lod,
                        existing_count,
                        eq_bounds,
                    )));

                    node.content = NodeContent::Branch {
                        children: Box::new(children),
                    };

                    // Now insert the new coord into this (now-branch) node
                    Self::insert_into(node, coord, lod, tile_count)
                }
            }

            NodeContent::Branch { children } => {
                let q = bounds.quadrant_of(coord);
                match &mut children[q] {
                    Some(child) => Self::insert_into(child, coord, lod, tile_count),
                    None => {
                        let q_bounds = bounds.quadrant_bounds(q);
                        children[q] = Some(Box::new(QuadNode::new_leaf(
                            coord, lod, tile_count, q_bounds,
                        )));
                        true
                    }
                }
            }
        };

        node.recompute_aggregate();
        added
    }

    // ── Internal: remove ───────────────────────────────────────────────────

    /// Remove a coord from the subtree. Returns `true` if found and removed.
    ///
    /// When a leaf matches, the caller (parent branch) is responsible for
    /// setting `children[q] = None`. This avoids fighting the borrow checker.
    fn remove_from(node: &mut QuadNode, coord: ChunkCoord) -> bool {
        match &node.content {
            NodeContent::Leaf {
                coord: existing, ..
            } => {
                if *existing == coord {
                    // Signal to caller: this leaf should be removed
                    return true;
                }
                return false;
            }
            NodeContent::Branch { .. } => {}
        }

        // We're a branch — delegate to the appropriate child
        let q = node.bounds.quadrant_of(coord);

        let removed = if let NodeContent::Branch { children } = &mut node.content {
            match &mut children[q] {
                Some(child) => {
                    let found = Self::remove_from(child, coord);
                    if found {
                        // If the child is a leaf that matched, remove it.
                        // If the child is a branch, it already handled internal cleanup.
                        if matches!(child.content, NodeContent::Leaf { .. }) {
                            children[q] = None;
                        }
                    }
                    found
                }
                None => false,
            }
        } else {
            unreachable!()
        };

        if removed {
            node.recompute_aggregate();
        }
        removed
    }

    // ── Internal: update LOD ───────────────────────────────────────────────

    fn update_in(node: &mut QuadNode, coord: ChunkCoord, lod: ChunkLOD, tile_count: u16) {
        match &mut node.content {
            NodeContent::Leaf {
                coord: existing,
                lod: existing_lod,
                tile_count: existing_count,
            } => {
                if *existing == coord {
                    *existing_lod = lod;
                    *existing_count = tile_count;
                }
            }
            NodeContent::Branch { children } => {
                let q = node.bounds.quadrant_of(coord);
                if let Some(child) = &mut children[q] {
                    Self::update_in(child, coord, lod, tile_count);
                }
            }
        }
        node.recompute_aggregate();
    }

    // ── Internal: range query ──────────────────────────────────────────────

    fn collect_rect(node: &QuadNode, rect: &ChunkAABB, result: &mut Vec<ChunkCoord>) {
        // Prune: skip entire subtree if bounds don't overlap query
        if !node.bounds.intersects(rect) {
            return;
        }
        // Skip empty subtrees
        if node.aggregate.chunk_count == 0 {
            return;
        }

        match &node.content {
            NodeContent::Leaf { coord, .. } => {
                if rect.contains(*coord) {
                    result.push(*coord);
                }
            }
            NodeContent::Branch { children } => {
                for child in children.iter().flatten() {
                    Self::collect_rect(child, rect, result);
                }
            }
        }
    }

    // ── Internal: LOD query ────────────────────────────────────────────────

    fn collect_lod(
        node: &QuadNode,
        viewport: &ChunkAABB,
        pixels_per_chunk: f32,
        detail_threshold: f32,
        result: &mut Vec<LODResult>,
    ) {
        if !node.bounds.intersects(viewport) {
            return;
        }
        if node.aggregate.chunk_count == 0 {
            return;
        }

        // How large is this node on screen?
        let node_screen_size = node.bounds.size() as f32 * pixels_per_chunk;

        match &node.content {
            NodeContent::Leaf { coord, .. } => {
                if viewport.contains(*coord) {
                    if pixels_per_chunk >= detail_threshold {
                        result.push(LODResult::Detail(*coord));
                    } else {
                        result.push(LODResult::Aggregate {
                            bounds: node.bounds,
                            color: node.aggregate.dominant_color,
                            density: node.aggregate.density,
                        });
                    }
                }
            }
            NodeContent::Branch { children } => {
                if node_screen_size < detail_threshold {
                    // Entire branch is too small on screen — aggregate it
                    result.push(LODResult::Aggregate {
                        bounds: node.bounds,
                        color: node.aggregate.dominant_color,
                        density: node.aggregate.density,
                    });
                } else {
                    for child in children.iter().flatten() {
                        Self::collect_lod(
                            child,
                            viewport,
                            pixels_per_chunk,
                            detail_threshold,
                            result,
                        );
                    }
                }
            }
        }
    }
}

impl Default for QuadTreeIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cc(x: i32, y: i32) -> ChunkCoord {
        ChunkCoord::new(x, y)
    }

    fn default_lod() -> ChunkLOD {
        ChunkLOD::default()
    }

    #[test]
    fn empty_tree() {
        let tree = QuadTreeIndex::new();
        assert!(tree.is_empty());
        assert_eq!(tree.count(), 0);
        assert!(tree.query_rect(&ChunkAABB::new(-10, -10, 10, 10)).is_empty());
    }

    #[test]
    fn insert_single() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(5, 3), default_lod(), 10);

        assert_eq!(tree.count(), 1);
        let found = tree.query_rect(&ChunkAABB::new(0, 0, 10, 10));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0], cc(5, 3));
    }

    #[test]
    fn insert_two_same_quadrant() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(0, 0), default_lod(), 5);
        tree.insert(cc(1, 0), default_lod(), 5);

        assert_eq!(tree.count(), 2);
        let found = tree.query_rect(&ChunkAABB::new(-1, -1, 10, 10));
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn insert_requires_growth() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(0, 0), default_lod(), 5);
        tree.insert(cc(100, 200), default_lod(), 5);

        assert_eq!(tree.count(), 2);

        // Both should be findable
        let near = tree.query_rect(&ChunkAABB::new(-1, -1, 2, 2));
        assert_eq!(near.len(), 1);
        assert_eq!(near[0], cc(0, 0));

        let far = tree.query_rect(&ChunkAABB::new(99, 199, 101, 201));
        assert_eq!(far.len(), 1);
        assert_eq!(far[0], cc(100, 200));
    }

    #[test]
    fn insert_negative_coords() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(0, 0), default_lod(), 5);
        tree.insert(cc(-10, -20), default_lod(), 5);
        tree.insert(cc(50, -5), default_lod(), 5);

        assert_eq!(tree.count(), 3);

        let all = tree.query_rect(&ChunkAABB::new(-100, -100, 100, 100));
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn update_existing_does_not_increase_count() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(5, 5), default_lod(), 10);
        tree.insert(cc(5, 5), default_lod(), 20); // update

        assert_eq!(tree.count(), 1);
    }

    #[test]
    fn remove_single() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(3, 4), default_lod(), 5);
        assert!(tree.remove(cc(3, 4)));

        assert!(tree.is_empty());
        assert!(tree.query_rect(&ChunkAABB::new(0, 0, 10, 10)).is_empty());
    }

    #[test]
    fn remove_nonexistent() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(1, 1), default_lod(), 5);
        assert!(!tree.remove(cc(2, 2)));
        assert_eq!(tree.count(), 1);
    }

    #[test]
    fn remove_one_of_many() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(0, 0), default_lod(), 5);
        tree.insert(cc(10, 10), default_lod(), 5);
        tree.insert(cc(-5, -5), default_lod(), 5);

        assert!(tree.remove(cc(10, 10)));
        assert_eq!(tree.count(), 2);

        let remaining = tree.query_rect(&ChunkAABB::new(-100, -100, 100, 100));
        assert_eq!(remaining.len(), 2);
        assert!(remaining.contains(&cc(0, 0)));
        assert!(remaining.contains(&cc(-5, -5)));
    }

    #[test]
    fn query_rect_empty_region() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(0, 0), default_lod(), 5);
        tree.insert(cc(1, 1), default_lod(), 5);

        let found = tree.query_rect(&ChunkAABB::new(100, 100, 200, 200));
        assert!(found.is_empty());
    }

    #[test]
    fn query_rect_partial_overlap() {
        let mut tree = QuadTreeIndex::new();
        for x in 0..10 {
            for y in 0..10 {
                tree.insert(cc(x, y), default_lod(), 1);
            }
        }
        assert_eq!(tree.count(), 100);

        // Query top-left 5x5
        let found = tree.query_rect(&ChunkAABB::new(0, 0, 5, 5));
        assert_eq!(found.len(), 25);

        // Query bottom-right 3x3
        let found = tree.query_rect(&ChunkAABB::new(7, 7, 10, 10));
        assert_eq!(found.len(), 9);
    }

    #[test]
    fn update_lod_propagates() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(0, 0), default_lod(), 100);
        tree.insert(cc(1, 0), default_lod(), 200);

        let colored_lod = ChunkLOD {
            dominant_color: [255, 0, 0, 255],
            density: 0.5,
            top_layer: 2,
        };
        tree.update_lod(cc(0, 0), colored_lod, 100);

        // Root aggregate should reflect the update
        let root = tree.root.as_ref().unwrap();
        assert!(root.aggregate.chunk_count == 2);
    }

    #[test]
    fn lod_query_detail_at_close_zoom() {
        let mut tree = QuadTreeIndex::new();
        tree.insert(cc(0, 0), default_lod(), 10);
        tree.insert(cc(1, 0), default_lod(), 10);

        let viewport = ChunkAABB::new(-1, -1, 3, 3);
        let results = tree.query_lod(&viewport, 64.0, 4.0); // 64px per chunk, threshold 4px

        // At 64px/chunk, both chunks are well above detail threshold
        let detail_count = results
            .iter()
            .filter(|r| matches!(r, LODResult::Detail(_)))
            .count();
        assert_eq!(detail_count, 2);
    }

    #[test]
    fn lod_query_aggregate_at_far_zoom() {
        let mut tree = QuadTreeIndex::new();
        for x in 0..10 {
            for y in 0..10 {
                tree.insert(cc(x, y), default_lod(), 1);
            }
        }

        let viewport = ChunkAABB::new(-5, -5, 15, 15);
        // 0.1 px per chunk — everything is tiny
        let results = tree.query_lod(&viewport, 0.1, 4.0);

        // Should get aggregate results, not 100 individual details
        let agg_count = results
            .iter()
            .filter(|r| matches!(r, LODResult::Aggregate { .. }))
            .count();
        assert!(agg_count > 0, "expected aggregates at far zoom");
        assert!(
            agg_count < 100,
            "expected fewer results than individual chunks"
        );
    }

    #[test]
    fn growth_stress_test() {
        let mut tree = QuadTreeIndex::new();
        // Insert chunks at widely scattered positions
        let positions = [
            cc(0, 0),
            cc(1000, 1000),
            cc(-500, 500),
            cc(-1000, -1000),
            cc(0, 10000),
        ];

        for &pos in &positions {
            tree.insert(pos, default_lod(), 1);
        }

        assert_eq!(tree.count(), positions.len());

        // All should be findable
        let all = tree.query_rect(&ChunkAABB::new(-2000, -2000, 2000, 12000));
        assert_eq!(all.len(), positions.len());

        for &pos in &positions {
            let found = tree.query_rect(&ChunkAABB::new(pos.x, pos.y, pos.x + 1, pos.y + 1));
            assert_eq!(found.len(), 1, "failed to find {:?}", pos);
        }
    }

    #[test]
    fn aabb_quadrant_assignment() {
        let aabb = ChunkAABB::from_square(0, 0, 4);
        // mid = (2, 2)
        assert_eq!(aabb.quadrant_of(cc(0, 0)), 0); // NW
        assert_eq!(aabb.quadrant_of(cc(1, 1)), 0); // NW
        assert_eq!(aabb.quadrant_of(cc(2, 0)), 1); // NE
        assert_eq!(aabb.quadrant_of(cc(3, 1)), 1); // NE
        assert_eq!(aabb.quadrant_of(cc(0, 2)), 2); // SW
        assert_eq!(aabb.quadrant_of(cc(1, 3)), 2); // SW
        assert_eq!(aabb.quadrant_of(cc(2, 2)), 3); // SE
        assert_eq!(aabb.quadrant_of(cc(3, 3)), 3); // SE
    }
}
