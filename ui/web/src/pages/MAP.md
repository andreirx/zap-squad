# Pages (`ui/web/src/pages/`)

## Role: Route Handlers
This directory contains the top-level components that correspond to specific routes in the application.

## Pages

### GamePage (`/game`)
The main game view displaying the loaded level with entities.
- Uses `GameCanvas` component for rendering
- Loads level from storage
- Handles entity selection/interaction
- Pan/zoom navigation

### TileEditorPage (`/tiles`)
Wrapper for the TileEditor component.
- Create and edit tile definitions
- Pixel art editing with 128x128 canvas
- Support for TILE, PATH, and BRIDGE types
- Bridge association for PATH tiles

### CharacterEditorPage (`/characters`)
Wrapper for the CharacterEditor component.
- Create character sprites with visual states
- Animation support (idle, walk, attack)
- Direction support (N, E, S, W)

### ObjectEditorPage (`/objects`)
Wrapper for the ObjectEditor component.
- Create object sprites with visual states
- Simpler than characters (idle/landed only)

### MapEditorPage (`/maps`)
Wrapper for the MapEditor component.
- Full level editor with layers
- Terrain, paths, and entity placement
- Auto-connectivity and bridge generation

## Routing
Routes are defined in `App.tsx`:
```tsx
<Routes>
  <Route path="/" element={<GamePage />} />
  <Route path="/game" element={<GamePage />} />
  <Route path="/maps" element={<MapEditorPage />} />
  <Route path="/tiles" element={<TileEditorPage />} />
  <Route path="/characters" element={<CharacterEditorPage />} />
  <Route path="/objects" element={<ObjectEditorPage />} />
</Routes>
```

## Responsibilities
- Route parameters parsing
- Page-level state management
- Composition of editor/game components
- Navigation via NavBar component
