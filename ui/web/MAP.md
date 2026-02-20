# Web Application (`ui/web/`)

## Role: UI & Delivery
This is the frontend application. It is a "Detail" in Clean Architecture terms. The game logic should not depend on whether it is rendered in React, Vue, or a native window.

## Technology Stack
- **Framework:** React
- **Build Tool:** Vite
- **Language:** TypeScript

## Dependencies
- **Depends on:** `infrastructure/wasm` (to communicate with the Core).
- **Depends on:** `adapters` (types and interfaces, if shared).

## Navigation
- [Editors](./src/editors/MAP.md)
- [Pages](./src/pages/MAP.md)
- [Storage](./src/storage/MAP.md)
- [Hooks](./src/hooks/MAP.md)
- [Components](./src/components/MAP.md)

## Responsibilities
- **Rendering:** Displaying the game state to the user.
- **Input:** Capturing user input and sending it to the `Wasm` bridge (which forwards to `adapters`).
- **Assets:** Serving static assets from `public/mods/`.
- **Editing:** Content creation tools for tiles, characters, objects, and maps.

## Asset Structure (`public/mods/`)
```
public/mods/
├── tiles/{id}/
│   ├── definition.json (or properties.json)
│   └── tile_{0-14}.png (variations)
├── characters/{id}/
│   ├── definition.json
│   └── {id}_{visualState}_{animation}_{direction}_{frame}.png
├── objects/{id}/
│   ├── definition.json
│   └── {id}_{visualState}_idle_{frame}.png
├── levels/{name}.json
└── hexmanos-mapping.json (UUID to folder name mapping)
```

## Tile Types & Rendering
- **TILE (Terrain):** Static terrain tiles with random variation selection
- **PATH:** Connectable path tiles with 15 variations (connectivity bitmask: N=8, S=4, W=2, E=1)
- **BRIDGE:** Rendered under ground paths when crossing water; connectivity matches the path above

## Terrain Types
- **LAND:** Standard walkable terrain
- **WATER:** Water terrain; ground paths crossing water auto-generate bridges

## Boundary
- **Input:** User events -> `Wasm` Bridge.
- **Output:** Game State updates <- `Wasm` Bridge.
