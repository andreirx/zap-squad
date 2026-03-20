# infrastructure/wasm-canvas/

## What
WASM entry point for the freedom-board infinite canvas editor.
Implements zap-engine's `Game` trait (`FreedomBoardGame`) to bridge
the React UI to the core `SparseWorld`.

## Architecture Role
This is an **infrastructure** component — the outermost ring of Clean Architecture.
It depends inward on `zapsquad-core` (entities + use cases) and sideways on
`zap-engine` (rendering framework). It contains zero business logic.

## Dependencies
- `zapsquad-core::entities::freedom_board` — SparseWorld, TileCoord, TilePlacement
- `zapsquad-core::use_cases::freedom_board` — place_tile, erase_tile, query_viewport
- `zap-engine` — Game trait, Entity, Scene, InputQueue
- `zap-web` — export_game! macro for WASM bindings

## Data Flow
```
React UI  --[custom events]--> FreedomBoardGame.update()
                                  |
                                  ├── mutates SparseWorld (place/erase)
                                  ├── queries visible tiles
                                  └── spawns/despawns engine Entities
                                         |
                               zap-engine renderer draws entities
                                         |
React UI  <--[SharedArrayBuffer]-- rendered frame
```

## Custom Event Protocol
See lib.rs header comment for the full event table.

## Maturity Level
**PROTOTYPE** — full despawn/respawn on every camera move.
Known technical debt:
- Entity pooling needed for >10K visible tiles
- No LOD rendering yet (query_viewport_lod exists in core but isn't wired)
- Sprite manifest loading not yet wired through pending reload
- Undo/redo stack unbounded (needs max depth)
