//! Freedom Board use cases — application-specific rules for the infinite canvas.
//!
//! Edit operations produce `EditResult` records for undo/redo.
//! Query operations are read-only and allocation-minimal where possible.

pub mod world_edit;
pub mod world_query;

pub use world_edit::{draw_line, erase_rect, erase_tile, fill_rect, flood_fill, place_tile, EditResult};
pub use world_query::{
    cardinal_neighbors, connectivity_bitmask, count_tiles_in_rect, get_chunk_tiles,
    is_occupied, is_occupied_on_layer, query_viewport, query_viewport_lod,
};
