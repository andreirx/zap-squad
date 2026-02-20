# ZapSquad Vision

## Mission
Create a **programmable 2D game engine** that enables kids to learn coding by making games.

## Core Features

### For Kids (Game Creators)
- **Visual Level Editor:** LDtk-compatible map editor for tile-based level design
- **Simple Scripting:** Rhai scripts for game logic (movement, interactions)
- **Instant Feedback:** Hot-reload scripts, see changes immediately
- **Asset Pipeline:** Built-in editors for characters, objects, and tiles

### For the Engine
- **A* Pathfinding:** NPCs navigate around obstacles
- **Group Movement:** Party members follow the leader
- **Physics:** Rapier2D for collisions and dynamics
- **Rendering:** WebGPU with HDR/EDR support via zap-engine

---

## Architecture Principles

### Clean Architecture Layers
```
+-----------------------------------------------------+
|                    CORE (Stable)                     |
|  +-----------------------------------------------+  |
|  |              Entities                          |  |
|  |  GameState, Actor, Level, Script               |  |
|  +-----------------------------------------------+  |
|  +-----------------------------------------------+  |
|  |              Use Cases                         |  |
|  |  Pathfinding, GroupMovement, ScriptExecution   |  |
|  +-----------------------------------------------+  |
+-----------------------------------------------------+
|                 ADAPTERS (Semi-Stable)              |
|  EngineGateway, AssetGateway, InputAdapter          |
|  CompositeRenderer, ScriptEngine                    |
+-----------------------------------------------------+
|               INFRASTRUCTURE (Volatile)              |
|  WASM exports, React UI, Asset files                |
+-----------------------------------------------------+
```

### Dependency Rule
- Infrastructure -> Adapters -> Core
- Core NEVER imports from Adapters or Infrastructure
- Data crosses boundaries via DTOs only

---

## Current Implementation Status

### What EXISTS (Scaffolded)
- **core/**: Rust game logic (CompositeActor, GameState, etc.)
- **adapters/**: Rust bridges (CompositeRenderer, ScriptEngine, AssetGateway)
- **infrastructure/wasm/**: WASM entry point with zap-engine Game trait implementation
- **ui/web/**: React editors (Character, Object, Tile, Map) + Canvas2D game preview

### What's WORKING
- All editors (Character, Object, Tile, Map) - fully functional
- Canvas2D rendering for map preview and game preview
- Storage layer (local filesystem via Vite plugin)
- Path auto-connectivity, bridge auto-placement
- LDtk-compatible level format

### What's NOT CONNECTED
- **WASM is NOT built or linked** - the Rust code exists but isn't compiled to WASM
- **zap-engine WebGPU rendering is NOT used** - React does its own Canvas2D rendering
- **Hot-reload to WASM is NOT wired** - scripts don't go through Rhai engine

---

## Target Architecture (Next Phase)

### Two Separate Deployments

```
zap-squad/
├── core/                    # Rust - pure game logic (NO rendering)
├── adapters/                # Rust - bridges to external systems
│
├── editor/                  # DEPLOYMENT 1: Authenticated editor suite
│   └── web/
│       ├── src/
│       │   ├── editors/     # Character, Object, Tile, Map editors
│       │   ├── storage/     # S3Storage with Cognito auth
│       │   └── components/  # Shared UI components
│       └── package.json
│
├── game/                    # DEPLOYMENT 2: Public game runtime
│   ├── wasm/                # Rust WASM build (zap-engine integration)
│   │   └── src/lib.rs       # Game trait impl, hot-reload exports
│   └── web/
│       ├── src/
│       │   ├── GameHost.tsx # WASM loader, canvas host
│       │   ├── ScriptPanel  # In-browser Rhai editing (optional)
│       │   └── ReloadBtn    # Hot reload trigger
│       └── package.json
│
└── shared/                  # Shared TypeScript types
    └── src/types/           # Asset schemas, API contracts
```

### Authentication Model
- **Editor**: Cognito authentication required to write assets to S3
- **Game**: No authentication - reads assets from public CDN/S3

### Rendering Architecture
- **Editor**: Canvas2D for previews (current implementation - fast, good enough)
- **Game**: zap-engine WebGPU for actual gameplay (GPU-accelerated, HDR support)

---

## Phase Plan

### Phase 1: WASM Build Pipeline (Current Gap)
1. Set up `wasm-pack` build for `infrastructure/wasm/`
2. Generate JS bindings and TypeScript types
3. Create simple test page that loads WASM and shows zap-engine canvas
4. Verify WebGPU rendering works in browser

### Phase 2: Game Runtime
1. Create `game/web/` React app (minimal - just WASM host)
2. Implement WASM loading and initialization
3. Connect level loading (fetch JSON, pass to WASM)
4. Connect hot-reload (scripts, manifests)
5. Add basic UI (level selector, reload button)

### Phase 3: Editor Separation
1. Move current `ui/web/` to `editor/web/`
2. Remove game runtime code from editor
3. Add Cognito authentication to editor
4. Configure S3 storage for production

### Phase 4: Integration
1. Editor "Play" button opens game in new tab/iframe
2. Game loads level from CDN
3. Scripts can be edited in game (ScriptPanel)
4. Hot-reload works for live iteration

---

## Target Audience
1. **Primary:** Kids aged 8-14 learning to code
2. **Secondary:** Educators teaching game development
3. **Tertiary:** Indie developers wanting a scriptable engine

## Success Metrics
- Kids can create a working game in under 1 hour
- Scripts are readable by someone with no coding experience
- Engine runs at 60fps on mid-range hardware
- All core logic testable without browser/WASM
