# Shared Components (`ui/web/src/components/`)

## Role: Reusable UI
This directory holds reusable React components that are used across both the Game and the Editors.

## Components

### PanZoomCanvas
Infinite canvas component with pan/zoom functionality.
- **Features:**
  - Scroll wheel to zoom (centers on cursor position)
  - Right-click drag, middle-click drag, or Space+drag to pan
  - Optional grid overlay
  - Coordinate conversion (screen <-> world)
  - Custom render callback for drawing content
- **Usage:**
  ```tsx
  <PanZoomCanvas
    width={2048}
    height={2048}
    showGrid
    gridSize={128}
    onRender={(ctx, transform) => {
      // Draw content in world coordinates
      ctx.fillRect(0, 0, 128, 128);
    }}
    onWorldClick={(x, y, button) => {
      console.log('Clicked at world:', x, y);
    }}
  />
  ```

### GameCanvas
Game rendering component that displays the current level.
- **Render Passes:**
  1. Terrain tiles with random variation selection
  2. Terrain transitions (edge blending)
  3. Water paths with connectivity
  4. Bridges with connectivity (matches path type above)
  5. Ground paths with connectivity
  6. Entities (characters and objects)
- **Features:**
  - Pan/zoom via PanZoomCanvas
  - Entity click detection
  - Animation tick for animated sprites
  - Auto-bridge rendering when ground paths cross water/rivers

### WasmGame
WebGPU game renderer using zap-engine WASM.
- **Features:**
  - Loads and initializes WASM module (`zapsquad_wasm`)
  - WebGPU rendering with GPU-instanced quads
  - Reads instance data directly from WASM memory
  - ~10,000 instances at 60fps
  - Hot-reload buttons for scripts and assets
  - Keyboard input forwarding (WASD/Arrows)
  - Pointer input forwarding
  - Scroll to pan, Ctrl+Scroll to zoom
- **Sprite Loading:**
  - Loads pre-baked atlases from `public/assets/manifest.json`
  - Converts manifest format to zap-engine sprite manifest
  - Uploads atlas textures to WebGPU
  - Atlas format: characters (rows=animations), tiles (row0=variations, rows1-8=transitions), weapons
- **Props:**
  - `levelId` - Level to load
  - `width`, `height` - Canvas dimensions
  - `onError` - Error callback
- **Route:** `/game/wasm`

### NavBar
Application navigation bar with links to Game, Map Editor, Tile Editor, Character Editor, and Object Editor.

## Rendering Details

### Path Connectivity
Paths use a 4-bit connectivity bitmask to select from 15 variations:
- N (North) = 8
- S (South) = 4
- W (West) = 2
- E (East) = 1
- Variation index = (bits === 0) ? 0 : bits - 1

### Bridge Rendering
Bridges are auto-generated when ground paths (PATH + LAND) cross water terrain or water paths (rivers).
- Bridge connectivity matches the path type above it
- Different path types crossing the same river will NOT have connected bridges
- The `bridgeAssetId` on a PATH tile specifies which BRIDGE tile to render

### Entity Sprites
- Characters: `{id}_full_idle_south_0.png` (default appearance)
- Objects: `{id}_new_idle_0.png` (default appearance)
- Fallback: Colored circle if sprite not found
