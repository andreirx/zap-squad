# Architecture Decisions

## ADR-001: Clean Architecture Foundation
**Date:** 2026-02-11
**Status:** Accepted

### Context
ZapSquad is designed to be a high-reliability game engine for educational use.

### Decision
Adopt Clean Architecture with strict layer separation:
- core/ contains pure business logic (no framework deps)
- adapters/ bridges core to external systems
- infrastructure/ contains volatile external details

### Consequences
- Core logic fully testable without WASM/browser
- zap-engine is an implementation detail, swappable
- Slightly more boilerplate for boundary crossing

---

## ADR-002: zap-engine as Rendering Backend
**Date:** 2026-02-11
**Status:** Accepted

### Context
Need WebGPU rendering with HDR support.

### Decision
Use zap-engine via adapter layer, not direct integration.

### Consequences
- Rendering is isolated behind EngineGateway
- Core doesn't know about sprites, shaders, etc.
- Future: could swap for native Metal/Vulkan backend

---

## ADR-003: Rhai for Scripting
**Date:** 2026-02-11
**Status:** Accepted

### Context
Kids need a simple, safe scripting language.

### Decision
Use Rhai (Rust-native, WASM-compatible, sandboxed).

### Consequences
- Simple syntax accessible to beginners
- No filesystem/network access (safe sandbox)
- Script execution happens in adapters layer

---

## ADR-004: Separate Editor and Game Deployments
**Date:** 2026-02-20
**Status:** Accepted

### Context
The editor requires authentication (Cognito) for asset creation and storage.
The game should be freely accessible without authentication.
These have different security requirements and deployment lifecycles.

### Decision
Split into two separate deployable applications:

```
zap-squad/
├── core/                    # Rust - pure game logic (NO rendering)
│   └── src/
│       ├── entities/        # Actor, Weapon, Tile, GameState
│       └── use_cases/       # Combat, Movement, AI
│
├── adapters/                # Rust - bridges core to infrastructure
│   └── src/
│       ├── script_engine/   # Rhai integration
│       ├── renderer/        # zap-engine integration
│       └── asset_loader/    # Load JSON definitions
│
├── editor/                  # SEPARATE DEPLOY - WITH Cognito auth
│   └── web/
│       ├── src/
│       │   ├── editors/     # Character, Weapon, Tile, Map editors
│       │   └── storage/     # S3Storage with Cognito auth
│       └── package.json
│
├── game/                    # SEPARATE DEPLOY - NO auth
│   ├── web/                 # Minimal React for config/scripting UI
│   │   └── src/
│   │       ├── GameCanvas   # WASM renders game here
│   │       ├── ConfigPanel  # Live game parameter tweaking
│   │       ├── ScriptPanel  # In-browser Rhai editing
│   │       └── ReloadBtn    # Hot reload trigger
│   └── wasm/                # Game-specific WASM build
│
└── shared/                  # Shared TypeScript types
    └── src/types/           # Asset schemas, API contracts
```

### Authentication Model
- **Editor**: Cognito authentication required to write assets to S3
- **Game**: No authentication - reads assets from public CDN/S3

### Hot Reload Flow
1. Game loads Rhai scripts from storage (local dev or CDN)
2. User edits script (in-game ScriptPanel OR external file)
3. Click "Reload" → WASM fetches fresh scripts → re-executes
4. Game continues with new AI/abilities/rules - no restart needed

### Consequences
- Editor and game can be deployed independently
- Game is freely accessible (no login friction)
- Editor protected by authentication
- Shared Rust core ensures consistency
- Slightly more complex build/deploy pipeline

---

## ADR-005: Freedom Board — Hybrid HashMap + Quadtree Spatial Storage
**Date:** 2026-03-20
**Status:** Accepted

### Context
Freedom Board is an infinite sparse tile canvas (editor + runtime). Needs O(1) point access for tile placement/removal and O(log N) range queries for viewport culling. The grid is unbounded (negative and positive coordinates). Millions of tiles may exist.

### Options Considered
1. **Dense 2D array** — O(1) access but wastes memory on sparse worlds, requires fixed bounds.
2. **HashMap<TileCoord, TilePlacement>** — O(1) point access, no spatial queries, poor cache locality for neighbor lookups.
3. **Quadtree only** — Good spatial queries, O(log N) point access (slower than needed for per-frame tile placement).
4. **Hybrid: HashMap<ChunkCoord, Chunk> + QuadTreeIndex** — O(1) point access via chunk lookup + array index, O(log N) range queries via quadtree over chunk coordinates. Cache-friendly: 32x32 chunk (8KB) fits L1 cache for neighbor lookups.

### Decision
Option 4: Hybrid HashMap + Quadtree.

- Primary storage: `HashMap<ChunkCoord, Chunk>` where Chunk is a flat `[Option<TilePlacement>; 1024]`.
- Spatial index: `QuadTreeIndex` over non-empty chunk coordinates with LOD aggregation.
- Chunk size 32x32 chosen for L1 cache fit (8KB per chunk at 8 bytes per `Option<TilePlacement>`).
- Quadtree grows dynamically by wrapping the old root as a quadrant of a new doubled root.

### Consequences
- Point operations (place/erase) are O(1): chunk lookup + array index.
- Viewport queries are O(k + log N): quadtree prunes, then iterate chunk tiles.
- Memory proportional to occupied area only (sparse). Empty chunks are never allocated.
- LOD rendering infrastructure ready (aggregate color/density propagated through quadtree).
- Negative coordinates work correctly via Euclidean division.
- Trade-off: two data structures must stay synchronized (chunk insert/remove must update quadtree).
