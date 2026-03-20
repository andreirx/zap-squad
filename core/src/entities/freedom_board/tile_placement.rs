//! What occupies a single cell in the infinite grid.
//!
//! `TilePlacement` is deliberately compact (6 bytes due to u16 alignment) because
//! millions of these may exist simultaneously. With `Option<TilePlacement>`, the
//! total is 8 bytes per cell. A full 32x32 chunk: 8 * 1024 = 8,192 bytes,
//! fitting comfortably in L1 cache (typically 32-64KB).

use serde::{Deserialize, Serialize};

/// Data stored in a single occupied cell of the sparse grid.
///
/// # Flags bitfield layout
/// ```text
/// bit 7: flip_x
/// bit 6: flip_y
/// bits 5-4: rotation (0=0deg, 1=90deg, 2=180deg, 3=270deg)
/// bits 3-0: reserved (must be 0)
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TilePlacement {
    /// Index into the asset registry. NOT a string on the hot path.
    pub asset_id: u16,
    /// Sprite variation (0-255). Interpretation depends on tile type:
    /// for terrain tiles this selects a visual variant, for path tiles
    /// this encodes the connectivity bitmask.
    pub variant: u8,
    /// Render layer (0-5). Maps to zap-engine's layer system.
    pub layer: u8,
    /// Transformation flags. See bitfield layout above.
    pub flags: u8,
}

impl TilePlacement {
    /// Create a placement with no transformation flags.
    pub const fn new(asset_id: u16, variant: u8, layer: u8) -> Self {
        Self {
            asset_id,
            variant,
            layer,
            flags: 0,
        }
    }

    pub const fn flip_x(self) -> bool {
        self.flags & 0x80 != 0
    }

    pub const fn flip_y(self) -> bool {
        self.flags & 0x40 != 0
    }

    /// Rotation in 90-degree increments (0, 1, 2, or 3).
    pub const fn rotation(self) -> u8 {
        (self.flags >> 4) & 0x03
    }

    pub const fn with_flags(mut self, flags: u8) -> Self {
        self.flags = flags;
        self
    }

    pub const fn with_flip_x(mut self, flip: bool) -> Self {
        if flip {
            self.flags |= 0x80;
        } else {
            self.flags &= !0x80;
        }
        self
    }

    pub const fn with_flip_y(mut self, flip: bool) -> Self {
        if flip {
            self.flags |= 0x40;
        } else {
            self.flags &= !0x40;
        }
        self
    }

    pub const fn with_rotation(mut self, rot: u8) -> Self {
        self.flags = (self.flags & 0xCF) | ((rot & 0x03) << 4);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_is_compact() {
        // 6 bytes: u16 (2) + u8 (1) + u8 (1) + u8 (1) + 1 byte alignment padding.
        // The u16 field requires 2-byte alignment, so the struct is padded to 6.
        assert_eq!(std::mem::size_of::<TilePlacement>(), 6);
        // Option discriminant adds 2 bytes (aligned to u16)
        assert_eq!(std::mem::size_of::<Option<TilePlacement>>(), 8);
        // Full chunk: 8 * 1024 = 8,192 bytes. Still fits in L1 cache (32-64KB).
    }

    #[test]
    fn default_flags_are_zero() {
        let tp = TilePlacement::new(42, 3, 1);
        assert!(!tp.flip_x());
        assert!(!tp.flip_y());
        assert_eq!(tp.rotation(), 0);
    }

    #[test]
    fn flip_x_flag() {
        let tp = TilePlacement::new(0, 0, 0).with_flip_x(true);
        assert!(tp.flip_x());
        assert!(!tp.flip_y());
        assert_eq!(tp.flags & 0x80, 0x80);

        let tp = tp.with_flip_x(false);
        assert!(!tp.flip_x());
    }

    #[test]
    fn flip_y_flag() {
        let tp = TilePlacement::new(0, 0, 0).with_flip_y(true);
        assert!(!tp.flip_x());
        assert!(tp.flip_y());
    }

    #[test]
    fn rotation_values() {
        for rot in 0..4u8 {
            let tp = TilePlacement::new(0, 0, 0).with_rotation(rot);
            assert_eq!(tp.rotation(), rot);
        }
    }

    #[test]
    fn combined_flags() {
        let tp = TilePlacement::new(10, 5, 2)
            .with_flip_x(true)
            .with_flip_y(true)
            .with_rotation(3);
        assert!(tp.flip_x());
        assert!(tp.flip_y());
        assert_eq!(tp.rotation(), 3);
        assert_eq!(tp.asset_id, 10);
        assert_eq!(tp.variant, 5);
        assert_eq!(tp.layer, 2);
    }

    #[test]
    fn rotation_wraps_to_2_bits() {
        // Values above 3 are masked to 2 bits
        let tp = TilePlacement::new(0, 0, 0).with_rotation(7);
        assert_eq!(tp.rotation(), 3); // 7 & 0x03 = 3
    }
}
