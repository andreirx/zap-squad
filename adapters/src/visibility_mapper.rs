//! Visibility projection — translates core cell states for rendering.
//!
//! Provides utility functions for converting CellState values to
//! rendering parameters. Currently used by infrastructure for entity
//! gating decisions. Will be extended when visual fog overlay rendering
//! is implemented (fog sprite alpha, chunk-level fog DTOs, etc.).
//!
//! The dense byte-mask projection (map_to_mask_bytes) was removed when
//! fog storage pivoted from bounded dense grid to sparse chunks.

use zapsquad_core::entities::game_rules::CellState;

/// Default byte value for Explored cells (~50% darkness).
/// Kept for any future rendering path that needs byte encoding.
pub const EXPLORED_BRIGHTNESS: u8 = 128;

/// Map a single CellState to a brightness byte (0=dark, 255=bright).
/// Useful for any rendering path that needs per-cell opacity.
pub fn cell_to_byte(cell: CellState) -> u8 {
    match cell {
        CellState::Hidden => 0,
        CellState::Explored => EXPLORED_BRIGHTNESS,
        CellState::Visible => 255,
    }
}

/// Alpha value for fog overlay rendering (0.0 = invisible, 1.0 = fully dark).
/// Will be consumed by fog overlay entity spawning when implemented.
pub fn fog_alpha(cell: CellState) -> f32 {
    match cell {
        CellState::Hidden => 1.0,
        CellState::Explored => 0.5,
        CellState::Visible => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_to_byte_mapping() {
        assert_eq!(cell_to_byte(CellState::Hidden), 0);
        assert_eq!(cell_to_byte(CellState::Explored), 128);
        assert_eq!(cell_to_byte(CellState::Visible), 255);
    }

    #[test]
    fn fog_alpha_values() {
        assert_eq!(fog_alpha(CellState::Hidden), 1.0);
        assert_eq!(fog_alpha(CellState::Explored), 0.5);
        assert_eq!(fog_alpha(CellState::Visible), 0.0);
    }
}
