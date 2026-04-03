//! Application-specific use cases
//!
//! These implement the business rules that are specific to ZapSquad.

mod pathfinding;
mod group_movement;
mod combat;
mod visibility;

/// Freedom Board use cases — edit and query operations on the infinite canvas.
pub mod freedom_board;

pub use pathfinding::{find_path, find_path_in_radius, InfiniteNavGrid, NavGrid, PathResult};
pub use group_movement::{FollowState, update_followers};
pub use combat::{apply_damage, calculate_damage, DamageResult};
pub use visibility::{update_visibility, Observer};
