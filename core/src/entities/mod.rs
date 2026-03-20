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

pub use actor::{Actor, ActorId};
pub use composite_actor::{AnimationState, CompositeActor, Direction, VisualState};
pub use game_state::GameState;
pub use level::{Level, Tile, TileId};
pub use script::{Script, ScriptId};
