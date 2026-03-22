# wasm-feather

## What
Pure-computation WASM crate that converts 128x128 sprite atlases into 160x160 feathered atlases. Each sprite is expanded with 16px mirrored padding on all sides, and an alpha gradient is applied so that overlapping tiles composite smoothly without hard seams.

## Architecture connection
- **Layer**: `infrastructure/` (volatile detail — framework-specific WASM binding)
- **Dependencies**: None on `core/` or `adapters/` — this is a standalone image-processing utility
- **Consumers**: Browser-side JS code fetches atlas PNGs and passes them through this WASM module before rendering
- **Replaces**: `tools/feather_atlases.py` (Python + NumPy implementation) — same algorithm, ported to Rust for in-browser execution

## Exports (wasm-bindgen)
| Function | Purpose |
|---|---|
| `init_feather()` | Set up panic hook and logger (call once) |
| `feather_atlas(png, feather, edge_alpha)` | Feather all rows of an atlas |
| `feather_atlas_with_max_rows(png, feather, edge_alpha, max_rows)` | Feather with row stripping |

## Native API
The same logic is available via `feather_atlas_native()` and `feather_atlas_native_with_max_rows()` for CLI tools and unit tests.
