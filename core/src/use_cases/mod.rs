//! Application-specific use cases
//!
//! These implement the business rules that are specific to ZapSquad.

mod pathfinding;
mod group_movement;

/// Freedom Board use cases — edit and query operations on the infinite canvas.
pub mod freedom_board;

pub use pathfinding::{find_path, NavGrid, PathResult};
pub use group_movement::{FollowState, update_followers};
