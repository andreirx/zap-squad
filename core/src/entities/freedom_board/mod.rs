//! Freedom Board — infinite sparse tile canvas entities.
//!
//! This module is self-contained. It does NOT depend on any existing
//! zap-squad entities (Level, Actor, GameState, etc.). It CAN be used
//! alongside them in the same process.
//!
//! # Architecture
//!
//! ```text
//! SparseWorld (the infinite grid)
//!   ├── HashMap<ChunkCoord, Chunk>    (O(1) point access)
//!   └── QuadTreeIndex                 (O(log N) spatial queries + LOD)
//!         └── indexed by ChunkCoord
//!
//! Chunk (32×32 tile block)
//!   └── [Option<TilePlacement>; 1024] (8KB, fits in L1 cache)
//!
//! TilePlacement (what's in a cell)
//!   └── 6 bytes: asset_id(u16) + variant(u8) + layer(u8) + flags(u8) + padding
//! ```

pub mod chunk;
pub mod coords;
pub mod quad_index;
pub mod sparse_world;
pub mod tile_placement;

// Re-export the public API
pub use chunk::{Chunk, ChunkLOD};
pub use coords::{ChunkCoord, TileCoord, CHUNK_AREA, CHUNK_SIZE};
pub use quad_index::{ChunkAABB, LODResult, NodeAggregate, QuadDebugNode, QuadTreeIndex};
pub use sparse_world::{SparseWorld, VisibleTile};
pub use tile_placement::TilePlacement;
