#!/usr/bin/env python3
"""
feather_atlases.py — Convert 128x128 tile atlases to 160x160 with feathered edges.

Each 128x128 sprite in the source atlas is expanded to 160x160:
  - 16px padding on all sides (allows feather up to 16px)
  - Padding filled with mirrored edge pixels from the original content
  - Alpha feather applied as a linear ramp:
      0%  at  feather pixels OUTSIDE the original edge
      50% at  the original edge
      100% at feather pixels INSIDE the original edge

The mirrored pixels ensure paths and terrain textures extend smoothly
outward rather than sampling from unknown neighboring tiles.

The original 128x128 content occupies pixels (16,16) to (143,143)
in the 160x160 output. Renderers align tiles to the grid using this
16px offset: screen_x = tile_x * tile_size - 16.

Usage:
    # Feather all atlases with 8px feather (default)
    python tools/feather_atlases.py ui/web/public/assets/tiles/ out/tiles/

    # Feather a single atlas with 12px feather
    python tools/feather_atlases.py ui/web/public/assets/tiles/iarba.png out/ --feather 12

    # Preview without writing
    python tools/feather_atlases.py ui/web/public/assets/tiles/ out/ --dry-run
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# ── Constants ──────────────────────────────────────────────────────────────────

SRC_SPRITE = 128        # Original sprite size in pixels
PAD = 16                # Padding on each side (maximum possible feather)
DST_SPRITE = SRC_SPRITE + 2 * PAD  # 160


# ── Pre-computed lookup tables ─────────────────────────────────────────────────
#
# These are the same for every sprite of the same size, so we build them
# once and reuse across all sprites in all atlases.


def _build_mirror_map() -> np.ndarray:
    """1D coordinate map: identity inside content region, mirrored in padding.

    For a 160-pixel axis with 16px padding and 128px content:
      padding left  [0..15]   -> mirrors to [31..16]   (inside content)
      content       [16..143] -> identity
      padding right [144..159] -> mirrors to [143..128] (inside content)
    """
    c = np.arange(DST_SPRITE)
    m = c.copy()

    # Left/top padding: reflect across the boundary at x=15.5
    lo = c < PAD
    m[lo] = 2 * PAD - 1 - c[lo]

    # Right/bottom padding: reflect across the boundary at x=143.5
    hi = c >= PAD + SRC_SPRITE
    m[hi] = 2 * (PAD + SRC_SPRITE) - 1 - c[hi]

    return m


def _build_alpha_field(feather: int, edge_alpha: float) -> np.ndarray:
    """2D alpha multiplier field for one sprite. Shape (160, 160), float64 in [0, 1].

    Uses signed distance from the original content boundary:
      positive = inside content
      negative = in padding
      zero     = at the edge

    Asymmetric ramp designed for source-over compositing:
      Inside band:   100% → edge_alpha  over feather pixels  (subtle fade)
      Outside band:  edge_alpha → 0%    over feather pixels  (visible soft edge)

    When two same-type tiles overlap, both contribute edge_alpha at the
    cell boundary. Source-over compositing gives:
      result = ea + ea * (1 - ea) = 2*ea - ea²
    At ea=0.8: result = 0.96 (4% background leak — nearly invisible).
    At ea=0.9: result = 0.99.

    At corners where both axes are near an edge, the minimum of the two
    axis distances is used. This produces a square-ish falloff at corners
    rather than circular. For 8-16px feather on 128px tiles, the visual
    difference is negligible.
    """
    c = np.arange(DST_SPRITE)

    # Per-axis signed distance from content boundary
    d_lo = c - PAD                          # distance from left/top edge
    d_hi = (PAD + SRC_SPRITE - 1) - c      # distance from right/bottom edge
    d_axis = np.minimum(d_lo, d_hi)         # nearest edge per axis

    # 2D: min of both axes
    dx, dy = np.meshgrid(d_axis, d_axis)
    signed_d = np.minimum(dx, dy).astype(np.float64)

    # Asymmetric alpha profile
    #   signed_d >= feather       → 1.0  (fully opaque interior)
    #   0 <= signed_d < feather   → edge_alpha + (1 - edge_alpha) * (signed_d / feather)
    #   -feather < signed_d < 0   → edge_alpha * (1 + signed_d / feather)
    #   signed_d <= -feather      → 0.0  (fully transparent)
    alpha = np.where(
        signed_d >= 0,
        # Inside content: ramp from edge_alpha (at edge) to 1.0 (at feather pixels in)
        np.clip(edge_alpha + (1.0 - edge_alpha) * signed_d / feather, edge_alpha, 1.0),
        # Outside content: ramp from edge_alpha (at edge) to 0.0 (at feather pixels out)
        np.clip(edge_alpha * (1.0 + signed_d / feather), 0.0, edge_alpha),
    )

    return alpha


# ── Per-sprite processing ─────────────────────────────────────────────────────


def feather_sprite(
    sprite: np.ndarray,
    alpha_field: np.ndarray,
    mirror_xx: np.ndarray,
    mirror_yy: np.ndarray,
) -> np.ndarray:
    """Expand one 128x128 RGBA sprite to 160x160 with mirrored feathered edges.

    Args:
        sprite:      (128, 128, 4) uint8 RGBA array
        alpha_field:  (160, 160) float64 alpha multiplier (pre-computed)
        mirror_xx:    (160, 160) int x-coordinate mirror map (pre-computed)
        mirror_yy:    (160, 160) int y-coordinate mirror map (pre-computed)

    Returns:
        (160, 160, 4) uint8 RGBA array
    """
    # Place original content into the center of a padded canvas
    canvas = np.zeros((DST_SPRITE, DST_SPRITE, 4), dtype=np.uint8)
    canvas[PAD : PAD + SRC_SPRITE, PAD : PAD + SRC_SPRITE] = sprite

    # Fill padding with mirrored pixels.
    # mirror_xx/mirror_yy map padding coordinates to their mirrored
    # source inside the content region. Inside the content region,
    # they are identity maps, so this is safe to apply everywhere.
    canvas = canvas[mirror_yy, mirror_xx].copy()

    # Apply alpha feather to the alpha channel
    raw_alpha = canvas[:, :, 3].astype(np.float64)
    canvas[:, :, 3] = np.clip(np.round(raw_alpha * alpha_field), 0, 255).astype(
        np.uint8
    )

    return canvas


# ── Atlas processing ───────────────────────────────────────────────────────────


def process_atlas(
    src_path: Path,
    dst_path: Path,
    alpha_field: np.ndarray,
    mirror_xx: np.ndarray,
    mirror_yy: np.ndarray,
    max_rows: int = 0,
) -> dict | None:
    """Process one atlas PNG: split into sprites, feather each, reassemble.

    Args:
        max_rows: If > 0, only process the first N rows (strips the rest).
                  Use max_rows=1 to keep only base variations (row 0).

    Returns metadata dict on success, None on skip.
    """
    img = Image.open(src_path).convert("RGBA")
    w, h = img.size

    if w % SRC_SPRITE != 0 or h % SRC_SPRITE != 0:
        print(f"  SKIP {src_path.name}: {w}x{h} not divisible by {SRC_SPRITE}")
        return None

    cols = w // SRC_SPRITE
    src_rows = h // SRC_SPRITE
    rows = min(src_rows, max_rows) if max_rows > 0 else src_rows
    src_data = np.array(img)

    # Allocate destination atlas (only for rows we're keeping)
    dst_w = cols * DST_SPRITE
    dst_h = rows * DST_SPRITE
    dst_data = np.zeros((dst_h, dst_w, 4), dtype=np.uint8)

    sprites_processed = 0
    sprites_empty = 0

    for row in range(rows):
        for col in range(cols):
            # Extract source sprite
            sy = row * SRC_SPRITE
            sx = col * SRC_SPRITE
            sprite = src_data[sy : sy + SRC_SPRITE, sx : sx + SRC_SPRITE]

            # Skip fully transparent sprites (no content to feather)
            if sprite[:, :, 3].max() == 0:
                sprites_empty += 1
                continue

            feathered = feather_sprite(sprite, alpha_field, mirror_xx, mirror_yy)

            # Place into destination grid
            dy = row * DST_SPRITE
            dx = col * DST_SPRITE
            dst_data[dy : dy + DST_SPRITE, dx : dx + DST_SPRITE] = feathered
            sprites_processed += 1

    # Write output
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    dst_img = Image.fromarray(dst_data)
    dst_img.save(dst_path, "PNG")

    stripped = src_rows - rows
    return {
        "name": src_path.name,
        "src_size": f"{w}x{h}",
        "dst_size": f"{dst_w}x{dst_h}",
        "src_grid": f"{cols}x{src_rows}",
        "dst_grid": f"{cols}x{rows}",
        "stripped": stripped,
        "processed": sprites_processed,
        "empty": sprites_empty,
    }


# ── CLI ────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Convert 128x128 tile atlases to 160x160 with feathered edges.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s tiles/ out/                     # All PNGs, default feather=8
  %(prog)s tiles/iarba.png out/ -f 12      # Single file, 12px feather
  %(prog)s tiles/ out/ --dry-run           # Preview only
        """,
    )
    parser.add_argument("input", type=Path, help="Atlas PNG or directory of PNGs")
    parser.add_argument("output", type=Path, help="Output directory")
    parser.add_argument(
        "-f",
        "--feather",
        type=int,
        default=8,
        help=f"Feather width in pixels, 1-{PAD} (default: 8)",
    )
    parser.add_argument(
        "-e",
        "--edge-alpha",
        type=float,
        default=0.8,
        help="Alpha at the content edge, 0.0-1.0 (default: 0.8). "
        "Higher = less visible same-type seams but subtler inter-type transitions. "
        "Source-over compositing: two tiles at edge_alpha produce "
        "result = 2*ea - ea^2 (0.8 -> 96%%, 0.9 -> 99%%).",
    )
    parser.add_argument(
        "-r",
        "--rows",
        type=int,
        default=0,
        help="Maximum number of rows to process per atlas (0 = all). "
        "Use --rows 1 to strip transition rows (1-8) and keep only base variations.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be processed, don't write files",
    )

    args = parser.parse_args()

    # ── Validate ───────────────────────────────────────────────────────────
    if args.feather < 1 or args.feather > PAD:
        print(f"ERROR: feather must be 1-{PAD}, got {args.feather}", file=sys.stderr)
        sys.exit(1)

    if args.edge_alpha < 0.0 or args.edge_alpha > 1.0:
        print(f"ERROR: edge-alpha must be 0.0-1.0, got {args.edge_alpha}", file=sys.stderr)
        sys.exit(1)

    if args.input.is_file():
        files = [args.input]
    elif args.input.is_dir():
        files = sorted(args.input.glob("*.png"))
    else:
        print(f"ERROR: {args.input} not found", file=sys.stderr)
        sys.exit(1)

    if not files:
        print("No PNG files found.")
        sys.exit(0)

    # ── Report plan ────────────────────────────────────────────────────────
    print(f"Feather atlas conversion")
    print(f"  Sprite: {SRC_SPRITE}x{SRC_SPRITE} -> {DST_SPRITE}x{DST_SPRITE}")
    ea = args.edge_alpha
    composited = 2 * ea - ea * ea
    print(f"  Feather: {args.feather}px, edge alpha: {ea:.0%}")
    print(f"  Profile: 0% at -{args.feather}px, {ea:.0%} at edge, 100% at +{args.feather}px")
    print(f"  Same-type seam opacity: {composited:.1%} (source-over: 2*ea - ea^2)")
    print(f"  Padding: {PAD}px each side (content at [{PAD},{PAD}] to [{PAD+SRC_SPRITE-1},{PAD+SRC_SPRITE-1}])")
    if args.rows > 0:
        print(f"  Row limit: {args.rows} (strips transition rows)")
    print(f"  Files: {len(files)}")
    print()

    if args.dry_run:
        for f in files:
            img = Image.open(f)
            w, h = img.size
            if w % SRC_SPRITE != 0 or h % SRC_SPRITE != 0:
                print(f"  SKIP  {f.name}: {w}x{h} not divisible by {SRC_SPRITE}")
            else:
                cols, rows = w // SRC_SPRITE, h // SRC_SPRITE
                print(
                    f"  OK    {f.name}: {cols}x{rows} sprites, "
                    f"{w}x{h} -> {cols * DST_SPRITE}x{rows * DST_SPRITE}"
                )
        print("\nDry run complete. No files written.")
        return

    # ── Pre-compute shared structures ──────────────────────────────────────
    mirror_1d = _build_mirror_map()
    alpha_field = _build_alpha_field(args.feather, args.edge_alpha)

    # Expand 1D mirror map to 2D meshgrid (reused for every sprite)
    mirror_xx, mirror_yy = np.meshgrid(mirror_1d, mirror_1d)

    # ── Process ────────────────────────────────────────────────────────────
    results = []
    for f in files:
        dst = args.output / f.name
        info = process_atlas(f, dst, alpha_field, mirror_xx, mirror_yy, max_rows=args.rows)
        if info:
            results.append(info)
            strip_msg = f", {info['stripped']} rows stripped" if info["stripped"] > 0 else ""
            print(
                f"  {info['name']:30s}  {info['src_grid']:>5s} -> {info['dst_grid']:>5s}  "
                f"{info['src_size']:>10s} -> {info['dst_size']:>10s}  "
                f"({info['processed']} drawn, {info['empty']} empty{strip_msg})"
            )

    print(f"\nDone. {len(results)} atlas(es) written to {args.output}/")


if __name__ == "__main__":
    main()
