# ui/canvas/

## What
Vite + React frontend for the freedom-board infinite canvas editor.
Renders via zap-engine's WASM pipeline (Canvas2D or WebGPU).

## Architecture Role
This is **infrastructure** — the outermost ring. It is a presentation detail.
All business logic lives in `core/`. This app only:
1. Captures user input (mouse, keyboard, wheel)
2. Converts screen coordinates to tile coordinates
3. Sends custom events to the WASM worker
4. Displays the rendered frame

## Key Components
- `InfiniteCanvas` — owns camera state, handles pan/zoom/click, hosts the zap-engine canvas
- `Toolbar` — tool selection (pan, draw, erase, fill) and active tile ID
- `StatusBar` — cursor position, camera state, world stats

## Data Flow
```
User Input (mouse/wheel/keyboard)
  --> InfiniteCanvas (screen-to-tile math)
    --> sendEvent({ type: 'custom', kind, a, b, c })
      --> Web Worker --> WASM game_custom_event()
        --> FreedomBoardGame.handle_custom_event()
          --> SparseWorld.set() / .remove()
          --> rebuild_visible_entities()
        --> SharedArrayBuffer frame data
      --> Renderer draws to canvas
```

## Camera Model
- `cameraX, cameraY`: top-left of viewport in tile coordinates (floats)
- `zoom`: pixels per tile (default 64, range 4-256)
- Screen to tile: `tileX = floor(screenX / zoom + cameraX)`
- Zoom centered on cursor via algebraic inversion of the mapping

## Dev Server
Port 5179 (avoids collision with zap-squad on 5178).
Requires COOP/COEP headers (configured in vite.config.ts).

## Maturity Level
**PROTOTYPE** — functional pan/zoom/draw/erase skeleton.
Known technical debt:
- No asset upload UI yet
- No sprite manifest loading pipeline
- Toolbar is minimal (numeric tile ID only)
- No undo/redo UI (core supports it, not wired to keyboard shortcuts)
- Grid overlay uses CSS, may need WebGL overlay at extreme zoom levels
