//! Core domain entities
//!
//! These are the fundamental business objects that exist independent
//! of any particular application or framework.

mod actor;
mod game_state;
mod level;
mod script;

pub use actor::{Actor, ActorId};
pub use game_state::GameState;
pub use level::{Level, Tile, TileId};
pub use script::{Script, ScriptId};
