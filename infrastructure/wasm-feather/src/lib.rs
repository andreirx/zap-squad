//! # wasm-feather
//!
//! Pure-computation crate that expands 128x128 sprite atlases into 160x160
//! feathered atlases. Each sprite gains 16px mirrored padding on every side,
//! with an alpha gradient that produces smooth compositing seams.
//!
//! Designed to run both as native Rust (for testing / CLI) and as WASM
//! (via wasm-bindgen for browser-side atlas processing).
//!
//! ## Algorithm overview
//!
//! 1. **Mirror map** (1D, 160 elements): identity inside content [16..143],
//!    reflected into padding [0..15] and [144..159].
//! 2. **Alpha field** (2D, 160x160): signed-distance from content boundary
//!    with an asymmetric ramp (inside: edge_alpha→1.0, outside: edge_alpha→0.0).
//! 3. **Per-sprite**: place 128x128 content at (16,16), fill padding via
//!    mirror map, multiply alpha channel by alpha field.
//! 4. **Atlas assembly**: split source PNG into 128x128 grid, feather each
//!    non-empty sprite, reassemble into 160x160 grid.

use image::{ImageFormat, RgbaImage};
use wasm_bindgen::prelude::*;

// ── Constants ────────────────────────────────────────────────────────────────

/// Original sprite size in pixels.
const SRC_SPRITE: u32 = 128;

/// Padding on each side (maximum possible feather width).
const PAD: u32 = 16;

/// Output sprite size: 128 + 2 * 16 = 160.
const DST_SPRITE: u32 = SRC_SPRITE + 2 * PAD;

// ── Lookup tables ────────────────────────────────────────────────────────────

/// Build a 1D coordinate mirror map of length `DST_SPRITE` (160).
///
/// - Content region `[PAD .. PAD+SRC_SPRITE-1]` maps to itself (identity).
/// - Left padding `[0 .. PAD-1]` mirrors into `[2*PAD-1 .. PAD]`.
/// - Right padding `[PAD+SRC_SPRITE .. DST_SPRITE-1]` mirrors into
///   `[PAD+SRC_SPRITE-1 .. PAD]` (i.e. reflects across the right boundary).
fn build_mirror_map() -> [u32; DST_SPRITE as usize] {
    let mut map = [0u32; DST_SPRITE as usize];
    for i in 0..DST_SPRITE {
        let idx = i as usize;
        if i < PAD {
            // Left/top padding: reflect across boundary at PAD - 0.5
            map[idx] = 2 * PAD - 1 - i;
        } else if i >= PAD + SRC_SPRITE {
            // Right/bottom padding: reflect across boundary at PAD + SRC_SPRITE - 0.5
            map[idx] = 2 * (PAD + SRC_SPRITE) - 1 - i;
        } else {
            // Content region: identity
            map[idx] = i;
        }
    }
    map
}

/// Build a 2D alpha field of size `DST_SPRITE x DST_SPRITE` (160x160).
///
/// Uses signed distance from the content boundary with an asymmetric ramp:
/// - `signed_d >= feather`      : 1.0  (fully opaque interior)
/// - `0 <= signed_d < feather`  : edge_alpha + (1 - edge_alpha) * (signed_d / feather)
/// - `-feather < signed_d < 0`  : edge_alpha * (1 + signed_d / feather)
/// - `signed_d <= -feather`     : 0.0  (fully transparent)
///
/// X and Y distances are combined with the minimum operator.
fn build_alpha_field(feather: u32, edge_alpha: f32) -> Vec<f32> {
    let n = DST_SPRITE as usize;
    let feather_f = feather as f32;

    // Per-axis signed distance from content boundary
    let mut d_axis = vec![0.0f32; n];
    for i in 0..n {
        let d_lo = i as f32 - PAD as f32;
        let d_hi = (PAD + SRC_SPRITE - 1) as f32 - i as f32;
        d_axis[i] = d_lo.min(d_hi);
    }

    // 2D field: min of both axes
    let mut field = vec![0.0f32; n * n];
    for y in 0..n {
        for x in 0..n {
            let signed_d = d_axis[x].min(d_axis[y]);

            let alpha = if signed_d >= feather_f {
                1.0
            } else if signed_d >= 0.0 {
                // Inside content: ramp from edge_alpha at edge to 1.0 at feather pixels in
                let t = signed_d / feather_f;
                (edge_alpha + (1.0 - edge_alpha) * t).clamp(edge_alpha, 1.0)
            } else if signed_d > -feather_f {
                // Outside content: ramp from edge_alpha at edge to 0.0 at feather pixels out
                let t = 1.0 + signed_d / feather_f;
                (edge_alpha * t).clamp(0.0, edge_alpha)
            } else {
                0.0
            };

            field[y * n + x] = alpha;
        }
    }

    field
}

// ── Per-sprite processing ────────────────────────────────────────────────────

/// Feather a single 128x128 RGBA sprite into a 160x160 RGBA sprite.
///
/// - Places the original content at `(PAD, PAD)`.
/// - Fills padding pixels by mirror indexing from the content.
/// - Multiplies the alpha channel by the pre-computed alpha field.
fn feather_sprite(
    sprite: &[u8],
    alpha_field: &[f32],
    mirror_map: &[u32; DST_SPRITE as usize],
) -> Vec<u8> {
    let src = SRC_SPRITE as usize;
    let dst = DST_SPRITE as usize;
    let pad = PAD as usize;

    // Build canvas: place content at (PAD, PAD), then fill padding via mirror map.
    // We combine both steps by reading directly from the source via mirror coords.
    let mut canvas = vec![0u8; dst * dst * 4];

    for y in 0..dst {
        let sy = mirror_map[y] as usize;
        // sy is always in [PAD .. PAD+SRC_SPRITE-1], so content_y is in [0..127]
        let content_y = sy - pad;

        for x in 0..dst {
            let sx = mirror_map[x] as usize;
            let content_x = sx - pad;

            let src_off = (content_y * src + content_x) * 4;
            let dst_off = (y * dst + x) * 4;

            canvas[dst_off] = sprite[src_off];
            canvas[dst_off + 1] = sprite[src_off + 1];
            canvas[dst_off + 2] = sprite[src_off + 2];
            canvas[dst_off + 3] = sprite[src_off + 3];
        }
    }

    // Apply alpha feather: multiply existing alpha by the alpha field
    for y in 0..dst {
        for x in 0..dst {
            let idx = y * dst + x;
            let raw_alpha = canvas[idx * 4 + 3] as f32;
            let new_alpha = (raw_alpha * alpha_field[idx]).round().clamp(0.0, 255.0) as u8;
            canvas[idx * 4 + 3] = new_alpha;
        }
    }

    canvas
}

// ── Atlas processing (core, pure) ────────────────────────────────────────────

/// Process a full atlas: decode PNG bytes, feather each sprite, encode result.
///
/// This is the pure inner function shared by all public entry points.
fn process_atlas_inner(
    src_png: &[u8],
    feather: u32,
    edge_alpha: f32,
    max_rows: u32,
) -> Result<Vec<u8>, String> {
    // Validate parameters
    if feather < 1 || feather > PAD {
        return Err(format!("feather must be 1-{PAD}, got {feather}"));
    }
    if !(0.0..=1.0).contains(&edge_alpha) {
        return Err(format!("edge_alpha must be 0.0-1.0, got {edge_alpha}"));
    }

    // Decode source PNG
    let src_img = image::load_from_memory_with_format(src_png, ImageFormat::Png)
        .map_err(|e| format!("PNG decode failed: {e}"))?
        .into_rgba8();

    let (w, h) = src_img.dimensions();
    let src_s = SRC_SPRITE;

    if w % src_s != 0 || h % src_s != 0 {
        return Err(format!(
            "Atlas {w}x{h} not divisible by {src_s}"
        ));
    }

    let cols = w / src_s;
    let src_rows = h / src_s;
    let rows = if max_rows > 0 {
        src_rows.min(max_rows)
    } else {
        src_rows
    };

    // Pre-compute lookup tables
    let mirror_map = build_mirror_map();
    let alpha_field = build_alpha_field(feather, edge_alpha);

    let src_data = src_img.as_raw();
    let src_stride = (w * 4) as usize;

    // Allocate destination
    let dst_w = cols * DST_SPRITE;
    let dst_h = rows * DST_SPRITE;
    let dst_stride = (dst_w * 4) as usize;
    let mut dst_data = vec![0u8; (dst_h * dst_w * 4) as usize];

    let src_s_usize = src_s as usize;
    let dst_s_usize = DST_SPRITE as usize;

    for row in 0..rows {
        for col in 0..cols {
            // Extract source sprite into a contiguous SRC_SPRITE x SRC_SPRITE x 4 buffer
            let sy = (row * src_s) as usize;
            let sx = (col * src_s) as usize;

            // Check if sprite is empty (fully transparent) — skip if so
            let mut empty = true;
            'check: for r in 0..src_s_usize {
                for c in 0..src_s_usize {
                    let off = (sy + r) * src_stride + (sx + c) * 4;
                    if src_data[off + 3] != 0 {
                        empty = false;
                        break 'check;
                    }
                }
            }
            if empty {
                continue;
            }

            // Copy sprite into contiguous buffer (required for feather_sprite)
            let mut sprite_buf = vec![0u8; src_s_usize * src_s_usize * 4];
            for r in 0..src_s_usize {
                let src_row_start = (sy + r) * src_stride + sx * 4;
                let dst_row_start = r * src_s_usize * 4;
                sprite_buf[dst_row_start..dst_row_start + src_s_usize * 4]
                    .copy_from_slice(&src_data[src_row_start..src_row_start + src_s_usize * 4]);
            }

            // Feather
            let feathered = feather_sprite(&sprite_buf, &alpha_field, &mirror_map);

            // Place into destination grid
            let dy = (row * DST_SPRITE) as usize;
            let dx = (col * DST_SPRITE) as usize;
            for r in 0..dst_s_usize {
                let src_row_start = r * dst_s_usize * 4;
                let dst_row_start = (dy + r) * dst_stride + dx * 4;
                dst_data[dst_row_start..dst_row_start + dst_s_usize * 4]
                    .copy_from_slice(&feathered[src_row_start..src_row_start + dst_s_usize * 4]);
            }
        }
    }

    // Encode as PNG
    let dst_img = RgbaImage::from_raw(dst_w, dst_h, dst_data)
        .ok_or_else(|| "Failed to create output image".to_string())?;

    let mut png_bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut png_bytes));
    image::ImageEncoder::write_image(
        encoder,
        dst_img.as_raw(),
        dst_w,
        dst_h,
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| format!("PNG encode failed: {e}"))?;

    Ok(png_bytes)
}

// ── WASM-bindgen exports ─────────────────────────────────────────────────────

/// Initialize panic hook for better WASM error messages.
/// Call this once from JS before using other functions.
#[wasm_bindgen]
pub fn init_feather() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Info);
    log::info!("wasm-feather initialized (sprite: {SRC_SPRITE} → {DST_SPRITE}, pad: {PAD})");
}

/// Feather an atlas PNG. Takes raw PNG bytes, returns feathered PNG bytes.
///
/// All rows in the source atlas are processed.
///
/// # Arguments
/// - `src_png`: Raw PNG file bytes (128x128 grid atlas)
/// - `feather`: Feather width in pixels, 1..=16
/// - `edge_alpha`: Alpha at content edge, 0.0..=1.0 (typical: 0.8)
///
/// # Returns
/// Feathered PNG bytes (160x160 grid atlas)
#[wasm_bindgen]
pub fn feather_atlas(src_png: &[u8], feather: u32, edge_alpha: f32) -> Result<Vec<u8>, JsError> {
    process_atlas_inner(src_png, feather, edge_alpha, 0).map_err(|e| JsError::new(&e))
}

/// Feather an atlas PNG, keeping only the first `max_rows` rows.
///
/// Identical to `feather_atlas` but strips rows beyond `max_rows`.
/// Use `max_rows=1` to keep only base variations (row 0).
///
/// # Arguments
/// - `src_png`: Raw PNG file bytes (128x128 grid atlas)
/// - `feather`: Feather width in pixels, 1..=16
/// - `edge_alpha`: Alpha at content edge, 0.0..=1.0 (typical: 0.8)
/// - `max_rows`: Maximum number of rows to process (0 = all)
///
/// # Returns
/// Feathered PNG bytes (160x160 grid atlas, row-stripped)
#[wasm_bindgen]
pub fn feather_atlas_with_max_rows(
    src_png: &[u8],
    feather: u32,
    edge_alpha: f32,
    max_rows: u32,
) -> Result<Vec<u8>, JsError> {
    process_atlas_inner(src_png, feather, edge_alpha, max_rows).map_err(|e| JsError::new(&e))
}

// ── Public Rust API (for native use / testing) ───────────────────────────────

/// Native Rust entry point: feather an atlas from PNG bytes.
///
/// This is the same as the WASM export but returns a Rust `Result`
/// instead of `JsError`, making it suitable for CLI tools and tests.
pub fn feather_atlas_native(
    src_png: &[u8],
    feather: u32,
    edge_alpha: f32,
) -> Result<Vec<u8>, String> {
    process_atlas_inner(src_png, feather, edge_alpha, 0)
}

/// Native Rust entry point: feather an atlas with row stripping.
pub fn feather_atlas_native_with_max_rows(
    src_png: &[u8],
    feather: u32,
    edge_alpha: f32,
    max_rows: u32,
) -> Result<Vec<u8>, String> {
    process_atlas_inner(src_png, feather, edge_alpha, max_rows)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_map_is_valid() {
        let map = build_mirror_map();

        // All values must be within content region [PAD .. PAD+SRC_SPRITE-1]
        for &v in &map {
            assert!(v >= PAD, "mirror value {v} below PAD ({PAD})");
            assert!(
                v < PAD + SRC_SPRITE,
                "mirror value {v} above content end ({})",
                PAD + SRC_SPRITE - 1
            );
        }

        // Content region is identity
        for i in PAD..(PAD + SRC_SPRITE) {
            assert_eq!(map[i as usize], i, "content region must be identity");
        }

        // Left padding mirrors correctly
        assert_eq!(map[0], 2 * PAD - 1); // 31
        assert_eq!(map[(PAD - 1) as usize], PAD); // 16

        // Right padding mirrors correctly
        assert_eq!(map[(PAD + SRC_SPRITE) as usize], PAD + SRC_SPRITE - 1); // 143
        assert_eq!(map[(DST_SPRITE - 1) as usize], 2 * (PAD + SRC_SPRITE) - 1 - (DST_SPRITE - 1)); // 128
    }

    #[test]
    fn alpha_field_boundaries() {
        let field = build_alpha_field(8, 0.8);
        let n = DST_SPRITE as usize;

        // Center pixel should be 1.0
        let center = n / 2;
        assert!(
            (field[center * n + center] - 1.0).abs() < 1e-6,
            "center alpha must be 1.0"
        );

        // Corner pixel (0,0) should be 0.0 (outside feather zone)
        assert!(
            field[0].abs() < 1e-6,
            "corner (0,0) must be 0.0, got {}",
            field[0]
        );

        // Edge pixel (PAD, PAD) should be edge_alpha
        let edge_idx = PAD as usize * n + PAD as usize;
        assert!(
            (field[edge_idx] - 0.8).abs() < 1e-6,
            "edge pixel must be edge_alpha (0.8), got {}",
            field[edge_idx]
        );

        // Deep interior (PAD + feather, PAD + feather) should be 1.0
        let deep = (PAD as usize + 8) * n + (PAD as usize + 8);
        assert!(
            (field[deep] - 1.0).abs() < 1e-6,
            "deep interior must be 1.0, got {}",
            field[deep]
        );
    }

    #[test]
    fn alpha_field_symmetry() {
        let field = build_alpha_field(8, 0.8);
        let n = DST_SPRITE as usize;

        // The field should be symmetric: f(x,y) == f(y,x)
        for y in 0..n {
            for x in 0..n {
                let a = field[y * n + x];
                let b = field[x * n + y];
                assert!(
                    (a - b).abs() < 1e-6,
                    "alpha field not symmetric at ({x},{y}): {a} vs {b}"
                );
            }
        }

        // Horizontal symmetry: f(x,y) == f(n-1-x, y)
        for y in 0..n {
            for x in 0..n / 2 {
                let a = field[y * n + x];
                let b = field[y * n + (n - 1 - x)];
                assert!(
                    (a - b).abs() < 1e-6,
                    "alpha field not horizontally symmetric at ({x},{y})"
                );
            }
        }
    }

    #[test]
    fn feather_solid_sprite() {
        // Create a solid white 128x128 sprite
        let src_s = SRC_SPRITE as usize;
        let sprite = vec![255u8; src_s * src_s * 4];

        let mirror_map = build_mirror_map();
        let alpha_field = build_alpha_field(8, 0.8);

        let result = feather_sprite(&sprite, &alpha_field, &mirror_map);
        let dst = DST_SPRITE as usize;

        assert_eq!(result.len(), dst * dst * 4);

        // Center pixel: fully opaque white
        let center = dst / 2;
        let off = (center * dst + center) * 4;
        assert_eq!(result[off], 255); // R
        assert_eq!(result[off + 1], 255); // G
        assert_eq!(result[off + 2], 255); // B
        assert_eq!(result[off + 3], 255); // A (1.0 * 255)

        // Corner pixel (0,0): mirrored content but alpha = 0
        assert_eq!(result[3], 0); // A at (0,0)

        // Edge pixel (PAD, PAD): alpha should be ~0.8 * 255 = 204
        let edge_off = (PAD as usize * dst + PAD as usize) * 4;
        assert_eq!(result[edge_off + 3], 204); // 0.8 * 255 rounded
    }

    /// Round-trip: create a minimal 1x1 sprite atlas (128x128 single sprite),
    /// feather it, decode the result, and verify dimensions.
    #[test]
    fn round_trip_single_sprite() {
        // Create a 128x128 solid blue image
        let mut img = RgbaImage::new(SRC_SPRITE, SRC_SPRITE);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgba([0, 0, 255, 255]);
        }

        // Encode to PNG bytes
        let mut src_bytes = Vec::new();
        let encoder =
            image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut src_bytes));
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            SRC_SPRITE,
            SRC_SPRITE,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();

        // Feather
        let result_bytes = feather_atlas_native(&src_bytes, 8, 0.8).unwrap();

        // Decode result
        let result_img = image::load_from_memory_with_format(&result_bytes, ImageFormat::Png)
            .unwrap()
            .into_rgba8();

        assert_eq!(result_img.dimensions(), (DST_SPRITE, DST_SPRITE));

        // Center pixel should be solid blue, fully opaque
        let center = DST_SPRITE / 2;
        let px = result_img.get_pixel(center, center);
        assert_eq!(px[0], 0);
        assert_eq!(px[1], 0);
        assert_eq!(px[2], 255);
        assert_eq!(px[3], 255);
    }

    /// Test that a 2x1 atlas (256x128) produces a 320x160 result.
    #[test]
    fn atlas_grid_dimensions() {
        let cols = 2u32;
        let rows = 1u32;
        let w = cols * SRC_SPRITE;
        let h = rows * SRC_SPRITE;

        let mut img = RgbaImage::new(w, h);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgba([255, 0, 0, 128]);
        }

        let mut src_bytes = Vec::new();
        let encoder =
            image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut src_bytes));
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            w,
            h,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();

        let result_bytes = feather_atlas_native(&src_bytes, 8, 0.8).unwrap();
        let result_img = image::load_from_memory_with_format(&result_bytes, ImageFormat::Png)
            .unwrap()
            .into_rgba8();

        assert_eq!(
            result_img.dimensions(),
            (cols * DST_SPRITE, rows * DST_SPRITE)
        );
    }

    /// Test max_rows stripping: 1x2 atlas with max_rows=1 should produce 1x1 output.
    #[test]
    fn max_rows_strips_extra() {
        let cols = 1u32;
        let rows = 2u32;
        let w = cols * SRC_SPRITE;
        let h = rows * SRC_SPRITE;

        let mut img = RgbaImage::new(w, h);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgba([0, 255, 0, 200]);
        }

        let mut src_bytes = Vec::new();
        let encoder =
            image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut src_bytes));
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            w,
            h,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();

        let result_bytes =
            feather_atlas_native_with_max_rows(&src_bytes, 8, 0.8, 1).unwrap();
        let result_img = image::load_from_memory_with_format(&result_bytes, ImageFormat::Png)
            .unwrap()
            .into_rgba8();

        // Only 1 row kept
        assert_eq!(
            result_img.dimensions(),
            (cols * DST_SPRITE, 1 * DST_SPRITE)
        );
    }

    /// Empty sprites (all transparent) should remain empty in output.
    #[test]
    fn empty_sprite_stays_empty() {
        // 128x128 fully transparent
        let img = RgbaImage::new(SRC_SPRITE, SRC_SPRITE);

        let mut src_bytes = Vec::new();
        let encoder =
            image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut src_bytes));
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            SRC_SPRITE,
            SRC_SPRITE,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();

        let result_bytes = feather_atlas_native(&src_bytes, 8, 0.8).unwrap();
        let result_img = image::load_from_memory_with_format(&result_bytes, ImageFormat::Png)
            .unwrap()
            .into_rgba8();

        // Every pixel should be transparent
        for pixel in result_img.pixels() {
            assert_eq!(pixel[3], 0, "empty sprite must remain fully transparent");
        }
    }

    #[test]
    fn invalid_feather_rejected() {
        let img = RgbaImage::new(SRC_SPRITE, SRC_SPRITE);
        let mut src_bytes = Vec::new();
        let encoder =
            image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut src_bytes));
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            SRC_SPRITE,
            SRC_SPRITE,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();

        assert!(feather_atlas_native(&src_bytes, 0, 0.8).is_err());
        assert!(feather_atlas_native(&src_bytes, 17, 0.8).is_err());
        assert!(feather_atlas_native(&src_bytes, 8, -0.1).is_err());
        assert!(feather_atlas_native(&src_bytes, 8, 1.1).is_err());
    }

    #[test]
    fn non_divisible_atlas_rejected() {
        // 130x128 is not divisible by 128
        let img = RgbaImage::new(130, 128);
        let mut src_bytes = Vec::new();
        let encoder =
            image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut src_bytes));
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            130,
            128,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();

        assert!(feather_atlas_native(&src_bytes, 8, 0.8).is_err());
    }
}
