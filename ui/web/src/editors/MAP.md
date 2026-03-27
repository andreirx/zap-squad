# Editors (`ui/web/src/editors/`)

## Role: Content Creation Tools
This directory contains the tools used to create content for the game (Levels, Characters, Objects, Tiles). These are "Editor" mode features, distinct from the main "Game" mode.

## Editors

### CharacterEditor
Creates character source assets and triggers browser-side baking.
- **Authoritative source contract:** logical path `characters/{id}/definition.json` in `CharacterSourceDef` shape
- **Authoritative frame blobs:** logical path `characters/{id}/frames/{animation}/{direction}/{frame}.png`
- **Default physical storage:** IDB `files` store keys under `mods/characters/{id}/...` via `IdbStorage(basePath='mods')`
- **Animations authored directly:** `idle`, `walk`, `melee_attack`, `throw_attack`
- **Directions:** north, east, south, west
- **Save flow:** write source definition + frame blobs → invoke `character-baker.ts` → emit character-assets-changed UI event
- **Derived baked cache:** `baked/characters/{id}/atlas.png`, `baked.json`, `sprites.json`
- **Legacy filename scan:** retained only as migration on load, not as the main save format

### ObjectEditor
Creates object sprites used for world objects and ranged/throwable visuals.
- **Visual States:** new, worn, damaged, broken
- **Animations:** primarily idle-based presentation
- **Output (mods):** `mods/objects/{id}/{id}_{visualState}_{animation}_{frame}.png`
- **Output (atlas):** `assets/weapons/{id}.png` + updates `assets/manifest.json`
- **TODO:** Integrate with atlas baking system (Task #25)

### TileEditor
Creates tile definitions with pixel art variations.
- **Tile Types:**
  - `TILE` - Terrain tiles with 1-8 random variations
  - `PATH` - Connectable paths with 15 connectivity variations
  - `BRIDGE` - Bridge tiles rendered under paths crossing water
- **Terrain Types:** LAND, WATER
- **Bridge Association:** PATH tiles can reference a BRIDGE tile via `bridgeAssetId`
- **Legacy Transition Auto-Generation (TILE type only):**
  - On save, can generate 8 transition tiles from tile_0: N, NE, E, SE, S, SW, W, NW
  - These belong to the older skirt/transition pipeline and are no longer used by MapEditor
  - Output: `tile_0_transition_{dir}.png`
- **Two-Step Path Generation (PATH/BRIDGE):**
  1. **Fill All Backgrounds** - Fills all 15 variations with terrain colors (no paths)
  2. **Draw Paths on All 15** - Draws paths ON TOP of existing pixels with edge fading
  - Paths are transparent overlays, so any terrain can show through
  - This separation allows custom terrains or hand-drawn backgrounds under paths
- **Output:** `tiles/{id}/properties.json` + `tile_{0-14}.png`

### MapEditor
Full-featured level editor with layer support.
- **Layers:**
  - Terrain - Base terrain tiles
  - Paths - PATH and BRIDGE tiles with auto-connectivity
  - Entities - Characters and objects
- **Features:**
  - Pan/zoom canvas (scroll to zoom, right-click/middle-click/space+drag to pan)
  - Continuous painting with Bresenham line interpolation
  - Auto-bridge placement when ground paths cross water
  - Path connectivity auto-calculation (water paths same-type only, land paths target a shared road network)
  - No terrain skirt/transition overlays; terrain tiles render directly
- **Output:** `levels/{name}.json` (LDtk-compatible format)

## Shared Components

### PixelCanvas
Core pixel art editing component used by all sprite editors.
- 128x128 canvas (standard tile/sprite size)
- Tools: pencil, eraser, fill, line, rectangle, ellipse, color picker
- Undo/redo support
- Zoom and grid overlay
- Color palette with recent colors

### Toolbar
Shared toolbar component for tool selection, zoom, brush size, and undo/redo.

### ColorPicker
HSL color picker with opacity support and recent colors.

## Dependencies
- Uses `storage` to save definitions and images.
- Uses `hooks/useCanvasTransform` for pan/zoom functionality.
- Uses `components/PanZoomCanvas` for the map editor canvas.
