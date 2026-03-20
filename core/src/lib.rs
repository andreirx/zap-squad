//! ZapSquad Core - Business Logic Layer
//!
//! This crate contains pure business logic with no external framework dependencies.
//! It defines:
//! - Entities: Core domain objects (GameState, Actor, Level, Script)
//! - Use Cases: Application-specific rules (Pathfinding, GroupMovement, etc.)
//!
//! # Clean Architecture
//! This crate sits at the center of the dependency graph.
//! It MUST NOT import from adapters/ or infrastructure/.

pub mod entities;
pub mod use_cases;

// Re-export commonly used types from the original game modules.
// These are re-exported through entities/mod.rs and use_cases/mod.rs.
// freedom_board is accessed as zapsquad_core::entities::freedom_board
// and zapsquad_core::use_cases::freedom_board to avoid glob ambiguity.
pub use entities::{
    Actor, ActorId, AnimationState, CompositeActor, Direction, GameState,
    Level, Tile, TileId, Script, ScriptId, VisualState,
};
pub use use_cases::{find_path, NavGrid, PathResult, FollowState, update_followers};
