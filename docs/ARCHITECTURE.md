# Zap-Architect Architecture

## Overview

Zap-Architect is a programmable 2D game engine for kids, built with Rust/WASM and React. It provides:
- X-COM style sprite compositing (body + weapon layers)
- Hot-reloadable Rhai scripting
- LDtk-compatible level loading
- Integrated asset editors
- Local filesystem storage (dev) / S3 + Cognito (deployed)

## Directory Structure

```
zap-squad/
├── core/                    # Pure Rust business logic (no external deps)
│   └── src/entities/        # CompositeActor, Direction, AnimationState
├── adapters/                # Interface adapters (zap-engine, Rhai, LDtk)
│   └── src/                 # CompositeRenderer, ScriptEngine, AssetManifest
├── infrastructure/
│   └── wasm/               # WASM bindings, Game trait implementation
├── ui/web/                 # React frontend
│   ├── public/
│   │   ├── mods/           # Source assets (editable)
│   │   │   ├── characters/{id}/definition.json + *.png
│   │   │   ├── tiles/{id}/definition.json + *.png
│   │   │   ├── weapons/{id}/definition.json + *.png
│   │   │   ├── levels/*.json
│   │   │   └── scripts/*.rhai
│   │   └── assets/         # Baked atlases (generated)
│   │       ├── characters/{id}.png
│   │       ├── tiles/{id}.png
│   │       ├── weapons/{id}.png
│   │       └── manifest.json
│   └── src/
│       ├── components/     # GameCanvas, PanZoomCanvas
│       ├── editors/        # CharacterEditor, TileEditor, MapEditor
│       ├── hooks/          # useCanvasTransform, useHotReload
│       ├── pages/          # GamePage
│       └── storage/        # LocalStorage, S3Storage
└── tools/                  # Build tools
    ├── import-hexmanos.ts  # Import from hexmanos format
    └── bake-atlases.ts     # Sprite packing
```

## Asset Pipeline

### Source Assets (public/mods/)

Editable assets stored as individual files:

**Characters:**
- `{id}/definition.json` - metadata (name, frames, frameDuration)
- `{id}/{id}_{visualState}_{animation}_{frame}.png` - individual sprites

**Tiles:**
- `{id}/definition.json` - metadata (walkable, blocksVision)
- `{id}/tile_{variation}.png` - base tiles
- `{id}/tile_{variation}_transition_{dir}.png` - edge transitions

**Levels:**
- `{name}.json` - LDtk-compatible format with Tiles and Entities layers

### Baked Assets (public/assets/)

Optimized atlases for runtime:

```
make bake-atlases
```

Produces:
- One PNG atlas per character/tile/weapon
- `manifest.json` describing sprite locations

**Manifest Structure (v2 - simplified, no visual states):**
```json
{
  "version": 2,
  "spriteSize": 128,
  "maxFrames": 8,
  "characters": {
    "carnat_test": {
      "atlas": "characters/carnat_test.png",
      "atlasWidth": 1024,
      "atlasHeight": 1536,
      "animations": {
        "idle_south": { "row": 0, "frames": 1, "loop": true },
        "walk_south": { "row": 1, "frames": 4, "loop": true },
        "melee_attack_south": { "row": 2, "frames": 7, "loop": false }
      }
    }
  },
  "tiles": { ... },
  "weapons": { ... }
}
```

## Storage Gateway

Abstraction layer for dev vs production storage:

```typescript
interface StorageGateway {
  readText(path: string): Promise<string>;
  writeBytes(path: string, data: ArrayBuffer): Promise<void>;
  list(prefix: string): Promise<string[]>;
  getReadUrl(path: string): string;
}
```

**Development (LocalStorage):**
- Reads via Vite static file serving
- Writes via `/__write-file` Vite plugin endpoint
- Lists via `/__list-files` endpoint

**Production (S3Storage):**
- Reads via public S3 URLs
- Writes via presigned URLs
- Auth via Cognito Identity Pool

## Data Flow

### Development Workflow

```
1. Edit sprites in CharacterEditor/TileEditor
   └── Saves to public/mods/{type}/{id}/

2. Edit levels in MapEditor
   └── Saves to public/mods/levels/{name}.json

3. Run: make bake-atlases
   └── Reads public/mods/
   └── Writes public/assets/ (atlases + manifest.json)

4. Run: npm run dev
   └── GameCanvas loads /assets/manifest.json
   └── GameCanvas loads /assets/{type}/{id}.png atlases
   └── GameCanvas loads /mods/levels/{name}.json
```

### Production Deployment

```
1. Build: make build
   └── bake-atlases (generate atlases)
   └── wasm-pack build (compile WASM)
   └── vite build (bundle React)

2. Deploy to S3/CloudFront:
   └── dist/assets/ (JS/CSS bundles)
   └── assets/ (atlases + manifest)
   └── mods/levels/ (if user-editable levels)

3. Runtime:
   └── Fetch manifest.json (1 request)
   └── Fetch needed atlases (few requests)
   └── Render using atlas coordinates
```

## Sprite Naming Conventions

### Characters

**Source files:** `{id}_full_{animation}_{frame}.png`
- Only "full" visual state is used (hurt/critical states removed)
- animation: `idle_south`, `walk_north`, `melee_attack_east`, etc.
- frame: 0-indexed integer (max 8 frames per animation)

**Atlas layout:**
```
Columns: 8 (max frames)
Rows: one per animation (sorted alphabetically)
```

### Tiles

**Source files:**
- `tile_{variation}.png` - base tiles (row 0 in atlas)
- `tile_{variation}_transition_{dir}.png` - transitions (rows 1-8)

**Directions:** n, ne, e, se, s, sw, w, nw

### Weapons/Objects

**Source files:** `new_{animation}_{frame}.png`
- Only "new" visual state is used (worn/damaged/broken removed)
- animation: `idle`, `landed`
- frame: 0-indexed integer (max 8 frames per animation)

**Atlas layout:**
```
Columns: 8 (max frames)
Rows: one per animation (sorted alphabetically)
```

## Level Format (LDtk-compatible)

```json
{
  "levels": [{
    "identifier": "level_name",
    "pxWid": 512,
    "pxHei": 512,
    "layerInstances": [
      {
        "__identifier": "Tiles",
        "__type": "Tiles",
        "__gridSize": 32,
        "gridTiles": [
          { "px": [0, 0], "t": 5, "src": "grass" }
        ]
      },
      {
        "__identifier": "Entities",
        "__type": "Entities",
        "entityInstances": [
          {
            "__identifier": "Character",
            "px": [100, 100],
            "fieldInstances": [
              { "__identifier": "body_def_id", "__value": "carnat_test" }
            ]
          }
        ]
      }
    ]
  }]
}
```

## Sprite Sheet Editors

The editors work directly with atlas PNG files (no individual frame files needed):

### CharacterSheetEditor
- Loads character atlases from `assets/characters/{id}.png`
- Displays grid overlay with animation row labels
- Click cells to edit in detail view
- Save writes directly to atlas PNG

### TileSheetEditor
- Loads tile atlases from `assets/tiles/{id}.png`
- Shows base tiles (row 0) and 8 transition rows
- Click cells to edit variations

### WeaponSheetEditor
- Loads weapon atlases from `assets/weapons/{id}.png`
- Similar to character editor but with weapon-specific animations

### Workflow
1. Run `make bake-atlases` to generate initial atlases from imported sprites
2. Open sprite sheet editor (CharacterSheetEditor, TileSheetEditor, WeaponSheetEditor)
3. Click cells in the sprite sheet to select them
4. Edit the cell in the detail view (right panel)
5. Changes sync automatically to the sprite sheet
6. Press Ctrl+S to save the atlas PNG

### Shared Types
All editors and the game renderer use shared atlas schemas from `types/atlas.ts`:
- `CharacterAtlasSchema` - 8 columns (frames) x N rows (animations)
- `TileAtlasSchema` - N columns (variations) x 9 rows (base + 8 transitions)
- `WeaponAtlasSchema` - 8 columns (frames) x N rows (animations)

## Build Commands

```bash
make test           # Run Rust tests
make check          # Check compilation (including WASM)
make wasm           # Build WASM package
make import-hexmanos  # Import from hexmanos format
make bake-atlases   # Generate sprite atlases
make build          # Full build (wasm + atlases)
make dev            # Start dev server
```

## Freedom Board (Infinite Sparse Canvas)

A second WASM application alongside the main game, providing an infinite sparse tile canvas for world editing and gameplay.

**Core** (`core/src/entities/freedom_board/`, `core/src/use_cases/freedom_board/`):
- `SparseWorld`: HashMap<ChunkCoord, Chunk> + QuadTreeIndex. Pure Rust, no framework deps.
- Edit use cases: place, erase, fill, line (Bresenham), flood fill (BFS). All return invertible `EditResult` for undo/redo.
- Query use cases: viewport query, LOD query, connectivity bitmask.

**WASM** (`infrastructure/wasm-canvas/`):
- `FreedomBoardGame` implements zap-engine `Game` trait. Translates custom events from React into core mutations, spawns engine entities for rendering.

**UI** (`ui/canvas/`):
- React app on port 5179. InfiniteCanvas component owns camera, dispatches events to WASM.
- Loads tile manifest from shared assets (`ui/web/public/assets/`), never copies.

See `docs/freedom-board.md` for full documentation.

---

## Key Decisions

1. **One atlas per asset** (not one giant atlas) - enables incremental updates
2. **Variable frame counts** - animations keep their natural frame counts
3. **Manifest-driven** - single source of truth for sprite locations
4. **StorageGateway abstraction** - same code for dev/prod
5. **LDtk-compatible format** - can use LDtk for advanced level editing
6. **Hybrid HashMap+Quadtree for SparseWorld** - O(1) point ops + O(log N) spatial (see ADR-005)
