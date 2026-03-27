//! Core domain entities
//!
//! These are the fundamental business objects that exist independent
//! of any particular application or framework.

mod actor;
mod composite_actor;
mod game_state;
mod level;
mod script;

/// Freedom Board — infinite sparse tile canvas.
/// Self-contained module, no dependencies on other entities.
pub mod freedom_board;

/// Game Rules — teams, stats, resources, time models, events, and validation.
/// The domain model for playable games built on the freedom board substrate.
pub mod game_rules;

/// Asset schemas — the single source of truth for asset data formats.
/// Mirrors the JSON schemas in `schemas/`. Storage-independent.
pub mod asset_schema;

pub use actor::{Actor, ActorId};
pub use composite_actor::{AnimationState, CompositeActor, Direction, VisualState};
pub use game_state::GameState;
pub use level::{Level, Tile, TileId};
pub use script::{Script, ScriptId};
