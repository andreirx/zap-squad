# ZapSquad Vision

## Mission

Create a programmable 2D world-building and game-making system for kids, where the same world can be edited, populated, animated, and eventually played through character behavior scripts.

The product is not a split "editor app" and "game app" anymore. The product is a single unified web application centered on Freedom Board, with supporting editors for source assets.

---

## Product Direction

### 1. Freedom Board is the center

Freedom Board is the primary surface of the product:
- infinite sparse world canvas
- world editing surface
- character placement and movement surface
- future scripting, combat, and group-command surface
- future runtime for the actual playable experience

The old standalone renderers are no longer the main direction. They may still exist in the repository as reference or fallback code, but they are not the product path.

### 2. Editors are supporting authoring tools

The Tile, Character, Object, and Map editors remain important, but they are no longer the center of the user experience. Their role is:
- author 128x128 source assets
- author bounded LDtk-style maps when needed
- feed Freedom Board and the runtime pipeline

They are asset-production tools, not the gameplay destination.

### 3. Local-first, no backend for user content

The deployed product should ship seed assets from S3/CDN, but user-created work stays local to the browser unless the user explicitly exports it.

This is intentional:
- no moderation backend
- no untrusted public uploads
- full offline-capable editing after initial load
- explicit user ownership of data

### 4. Feathering is a runtime bake step, not an editor concern

Editors continue to work with raw 128x128 source sprites.

Freedom Board uses baked feathered atlases. Feathering is an intermediate transformation step, ultimately performed in WASM in the client/runtime pipeline, not in Python-only infrastructure and not inside the editors themselves.

### 5. Scripting starts with character behavior

The first scripting model for kids is character behavior scripting:
- patrol
- chase
- flee
- guard
- follow
- attack

World generation scripts and game-rule scripts remain valid future directions, but the first user-facing scripting milestone is character AI and behavior.

### 6. Asset model simplification

Weapons and objects are converging toward a simpler "object asset" model for visuals. Characters may reference melee equipment and ranged/throwable objects, but the product direction is toward fewer overlapping content categories and clearer runtime usage.

---

## Experience Goals

For the kid:
- draw or import tiles and characters
- place them into a world
- assign simple behavior scripts
- issue commands to one or many characters
- observe movement, combat, and interactions immediately

For the educator or advanced creator:
- inspect behavior in a deterministic system
- persist worlds and assets locally
- export/import all authored content
- iterate without needing a backend or deployment step

---

## Architectural Direction

### Clean Architecture remains mandatory

- `core/` contains stable rules, pure Rust, no framework dependencies
- `adapters/` contains reusable bridges such as scripting bindings
- `infrastructure/` contains WASM integration and volatile runtime details
- `ui/web/` contains the unified application shell and editors

Freedom Board is allowed to talk directly to `core/` from its WASM integration layer where the adapter boundary remains thin, but the dependency rule still holds: policy inward, details outward.

### Shared persistence model

All tools should converge on one browser-side persistence model:
- shared IndexedDB database
- explicit load/save to disk
- seed assets from CDN/S3
- user assets, levels, worlds, and settings stored locally

### Shared runtime semantics

The same tile and character rules must apply in:
- Freedom Board
- Map Editor preview
- future runtime/play mode

This includes rendering rules, path connectivity rules, bridge behavior, persistence formats, and script-triggered actions.

---

## World Rendering Direction

### Terrain

Terrain transitions are no longer authored or rendered via skirt/transition overlays. Terrain smoothing is handled by feathered rendering in Freedom Board. Map Editor should not depend on the old skirt tiles.

### Paths

The path system is intentionally asymmetric:
- water paths remain type-strict and connect only to the same water path type
- land paths should form a shared road network and connect across different non-water path types

This is a product choice, not a convenience hack. Roads should feel structurally connected even when their art styles differ. Rivers should remain semantically distinct by type.

### Bridges

Bridges are still derived from land paths crossing water. Their visual connectivity should follow the effective land-path network above them.

---

## Remaining Product Work

The remaining work is no longer about proving that the engine can render. It is about turning support modules into finished features.

### Feature track

1. Character scripting UI
2. Script assignment and reload flow
3. Script persistence
4. Attack UI and ranged-attack flow
5. Multi-select and group commands
6. Commander/follower behavior
7. Reliable idle/attack/return animation state behavior

### Platform track

1. Complete local-first persistence across all editors
2. Finish UUID-based runtime identity and user-asset loading
3. Wire the WASM feathering step into the runtime asset pipeline
4. Keep disk export/import first-class
5. Keep Freedom Board and Map Editor semantics aligned

---

## Definition of Done

Support alone is not done.

A capability is done only when both exist:
- the support module or engine primitive
- the user-facing feature that exposes it in the product

Examples:
- Rhai engine without a script UI is not done
- attack commands without attack interaction and feedback are not done
- follow-state math without group controls is not done

---

## Success Criteria

- A child can place characters into a world and make them do meaningful things with scripts.
- The same world can move from editing to play behavior without format conversion or duplicated logic.
- Terrain and path rendering feel visually coherent without manual transition assets.
- User-created work persists locally, exports cleanly, and imports back without corruption.
- The core rules remain testable off-target and independent of browser/runtime details.
