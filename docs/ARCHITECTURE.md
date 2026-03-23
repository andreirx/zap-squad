# ZapSquad Architecture

## Overview

ZapSquad is a unified Rust/WASM + React application for:
- authoring 128x128 source assets
- building worlds on an infinite sparse canvas
- placing and controlling characters
- evolving toward a scriptable playable runtime for kids

The current architectural center is Freedom Board inside the unified `ui/web/` app. Supporting editors remain important, but they feed the Freedom Board/runtime path rather than defining a separate product.

---

## Current Application Shape

### Main app shell

The main application lives in `ui/web/` and currently hosts:
- Freedom Board as the primary route
- Tile editor
- Character editor
- Object editor
- Map editor

Legacy renderer pages may still exist in the repository, but they are no longer the main product path and should not drive new architecture.

### Key directories

```text
zap-squad/
├── core/                         # Pure Rust business logic
│   └── src/
│       ├── entities/             # Stable domain entities
│       └── use_cases/            # Stable application rules
├── adapters/                     # Reusable bridges (Rhai bindings, manifests, gateways)
├── infrastructure/
│   ├── wasm-canvas/              # Freedom Board WASM runtime
│   ├── wasm-feather/             # Feather baking in Rust/WASM
│   └── wasm/                     # Older WASM runtime/reference path
├── ui/
│   ├── web/                      # Unified app shell and active product surface
│   └── canvas/                   # Freedom Board prototype/reference path
├── tools/                        # Import, bake, and support scripts
└── docs/                         # Product and architecture documentation
```

---

## Architectural Layers

### Core

`core/` contains stable policy and must remain independent of frameworks and runtime details.

Examples:
- world entities
- sparse-world storage
- pathfinding
- group-follow support
- combat primitives
- freedom-board use cases

Rules:
- no browser dependencies
- no React dependencies
- no engine dependencies
- logic must be testable off-target

### Adapters

`adapters/` contains reusable translation and gateway logic.

Examples:
- Rhai bindings and script command emission
- manifest interpretation
- engine-facing abstraction helpers

The adapters layer exists to keep volatile integration concerns out of `core/`, but Freedom Board currently keeps some thin integration logic in its WASM layer where that boundary is still small.

### Infrastructure

`infrastructure/` contains volatile implementation details:
- WASM exports
- Freedom Board runtime integration
- feather-baking module
- older runtime/reference WASM modules

This layer may know about engine details, asset loading mechanics, and browser integration concerns. It must not invert the dependency rule back into `core/`.

### UI

`ui/web/` is the user-facing product shell.

It contains:
- Freedom Board UI
- supporting editors
- browser-side storage wiring
- route structure
- import/export flows

The UI owns presentation and interaction state, not business rules.

---

## Product Surfaces

### Freedom Board

Freedom Board is both:
- the primary world-building canvas
- the primary runtime surface for future scripting, combat, and squad interaction

Its architecture is:

```text
ui/web/src/freedom-board/
  -> infrastructure/wasm-canvas/
     -> core/
```

Freedom Board owns:
- tile placement and editing tools
- map stamping into the sparse world
- character placement and movement commands
- auto-save and explicit save/load
- debug and profiling controls
- future scripting/combat/group-control UI

### Editors

The editors remain source-asset tools:
- TileEditor authors 128x128 source tile assets
- CharacterEditor authors source character assets
- ObjectEditor authors source object visuals, including ranged/throwable presentation assets
- MapEditor authors bounded LDtk-style maps and preview semantics

They do not define runtime rendering geometry. In particular, they do not work in feathered 160x160 space.

---

## Persistence Architecture

### Local-first model

The active persistence direction is:
- seed assets from CDN/S3
- user content in browser storage
- explicit export/import to disk
- no backend for user-generated content

This keeps moderation and sync out of scope while preserving offline-capable iteration.

### Shared browser storage

The shared browser-side persistence layer is IndexedDB:
- `assets`
- `levels`
- `worlds`
- `config`
- `files`

In practice, the application currently uses both:
- structured stores for worlds/settings and future asset identity
- a file-like IDB-backed storage path for editor-facing content reads/writes

This means the repository is mid-convergence, but the intended outcome is one coherent local-first persistence architecture rather than multiple independent storage silos.

### StorageGateway role

`StorageGateway` still matters, but its role has shifted:
- read seed content
- provide a file-like abstraction for editor workflows
- optionally support curator/admin asset management flows

It is no longer the primary place to anchor the user-content architecture.

---

## Asset Pipeline

### Source assets

Source assets remain 128x128 based.

Examples:
- tiles in `mods/tiles/{id}/...`
- characters in `mods/characters/{id}/...`
- objects in `mods/objects/{id}/...`
- maps in `mods/levels/{name}.json`

### Runtime atlases

Runtime rendering uses baked atlases and manifest metadata.

Important distinction:
- editors operate on raw/source assets
- Freedom Board operates on baked runtime assets

### Feathering

Feathering is a runtime bake step, not an editor concern.

Current state:
- Python tooling exists for offline conversion
- `infrastructure/wasm-feather/` exists as the intended runtime/client-side implementation

Target state:
- source 128x128 assets authored in editors
- feathered runtime atlases baked client-side or in the runtime pipeline
- Freedom Board consumes the feathered outputs only

---

## Rendering Semantics

### Terrain

Terrain smoothing no longer depends on old skirt/transition overlays. Freedom Board uses feathered tile rendering. Map Editor should not depend on the old generated transition PNGs.

### Paths

Path connectivity is intentionally asymmetric:
- `PATH + WATER` connects only to adjacent water paths of the same type
- `PATH + LAND` connects to adjacent land paths regardless of specific asset type

This rule must remain aligned between Freedom Board and Map Editor.

### Bridges

Bridges are structural overlays derived from land paths crossing water. Their connectivity should match the effective land-path network above them.

---

## Character and Scripting Direction

### Character feature model

Character support exists in the runtime already:
- placement
- selection
- movement targets
- smooth interpolation
- combat primitives
- script execution support

The architecture still needs the user-facing feature layer:
- script editing and assignment
- attack interaction
- ranged attack presentation
- multi-select and group commands
- commander/follower behavior

### Script scope

The first scripting scope is character behavior scripting, not world-authoring or rules-authoring.

Initial scripting focus:
- move
- face
- attack
- set animation
- query nearby actors
- build behaviors like patrol, chase, guard, and follow

---

## Current Architectural Constraints

1. `core/` must remain testable off-target.
2. Shared semantics must not drift between Freedom Board and Map Editor.
3. Editors must remain 128x128 source-authoring surfaces.
4. Runtime feathering must stay outside the editors.
5. Persistent identity must move toward UUID-based saved references rather than positional ordering.
6. Support modules are not considered complete until exposed as real product features.

---

## Authoritative Companion Docs

Use these alongside this document:
- `docs/VISION.md` for product direction
- `docs/DECISIONS.md` for current ADRs and active design choices
- `docs/NEXT_STEPS.md` for the actual execution plan
- `docs/storage-architecture.md` for local-first persistence details
- `docs/tile-rendering-system.md` for rendering and path semantics
- `docs/freedom-board.md` for sparse-world/runtime details
