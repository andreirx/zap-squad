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

// Re-export commonly used types
pub use entities::*;
pub use use_cases::*;
