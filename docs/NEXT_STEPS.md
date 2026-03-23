# Next Steps

This document tracks the remaining work for the current product direction.

The direction is:
- one unified web app
- Freedom Board as the primary runtime/editor surface
- source-asset editors as supporting tools
- local-first persistence
- character-behavior scripting as the first scripting experience

Support code that is not exposed as a finished feature remains incomplete.

---

## Current State

### Built

- Freedom Board is the main route and active development surface.
- Editors continue to author 128x128 source assets.
- Infinite sparse world storage, chunking, quadtree culling, map stamping, save/load, and auto-save exist.
- Character placement and smooth movement exist.
- Combat primitives and Rhai script primitives exist.
- WASM feathering crate exists.
- Debug/profiling overlay and persisted runtime settings exist.

### Deferred or incomplete

- User-facing script workflow
- User-facing combat workflow
- Multi-select and group control workflow
- Script persistence
- UUID-based runtime identity completion
- Dynamic runtime asset loading for user-created assets
- Wiring the WASM feathering step into the runtime pipeline

---

## Plan

### Phase 1: Align Tile Semantics Across Freedom Board and Map Editor

### Goal

Remove semantic drift between the two world surfaces.

### Tasks

1. Change non-water path connectivity so all LAND paths connect to one another regardless of path asset type.
2. Keep WATER paths strict: only same-type water paths connect.
3. Ensure bridge connectivity follows the effective LAND-path network above water.
4. Update Freedom Board rendering and Map Editor preview to use the same rule.
5. Update import/export assumptions and tests for the new path rule.

### Done when

- Roads of different non-water types visibly connect in both Freedom Board and Map Editor
- Rivers of different water types remain separate
- Bridge shapes match the visible road network

---

### Phase 2: Finish the Combat Feature Layer

### Goal

Convert combat support into an actual usable feature.

### Tasks

1. Expose attack targeting in Freedom Board UI.
2. Support ranged attacks through the object asset model.
3. Add range validation and failure feedback.
4. Add combat feedback: hit results, death/removal behavior, visible state changes.
5. Ensure characters return to a stable idle state after attack completion.

### Done when

- A user can select a character and attack a valid target from the UI
- Melee and ranged attacks both execute through the intended asset flow
- Animation state returns cleanly to idle after action completion

---

### Phase 3: Finish the Scripting Feature Layer

### Goal

Make scripting a first-class, teachable product feature.

### Tasks

1. Define the first scripting scope explicitly as character behavior scripting.
2. Add script editor UI in Freedom Board.
3. Add assign/unassign script workflow on characters.
4. Add reload/apply flow and play/pause execution control.
5. Persist `script_id` or equivalent stable script reference in world serialization.
6. Provide starter examples for patrol, chase, guard, follow, and attack behaviors.

### Done when

- A user can write a script, assign it to a character, save the world, reload, and retain behavior
- The scripting surface is narrow, understandable, and stable enough for kids

---

### Phase 4: Group Command Features

### Goal

Turn single-character movement into squad control.

### Tasks

1. Add multi-select.
2. Add group move commands.
3. Prevent overlap and naive pileups during group movement.
4. Expose commander/follower assignment.
5. Use the existing follow-state support as the core primitive, but finish the actual UX layer.

### Done when

- Multiple characters can be selected and moved together
- Followers can remain bound to a commander
- Group movement is visually and behaviorally coherent

---

### Phase 5: Close the Persistence Architecture

### Goal

Finish the local-first storage direction across all tools.

### Tasks

1. Ensure all editors persist through the shared browser-side storage path.
2. Keep explicit save/load to disk for worlds, levels, and assets.
3. Complete UUID-based runtime identity so saved data is independent of manifest ordering.
4. Support user-created assets consistently across editors and Freedom Board.
5. Preserve settings and recent-state continuity where useful.

### Done when

- User-created tiles, characters, objects, maps, and worlds survive reloads
- Export/import works without relying on positional indices
- Freedom Board can load and render user-created assets, not just seed assets

---

### Phase 6: Wire Feathering Into the Real Runtime Pipeline

### Goal

Eliminate Python-only dependence for the feathering step.

### Tasks

1. Invoke the WASM feathering module from the client-side asset pipeline.
2. Cache feathered outputs locally.
3. Keep editors working on raw 128x128 assets.
4. Ensure Freedom Board consumes the baked feathered outputs only.

### Done when

- The feathering pipeline runs client-side without Python
- Freedom Board uses the baked results
- Editors remain unaware of feathered atlas geometry

---

## Cross-Cutting Verification

For every phase:
- update the docs
- add or extend automated tests where the rule lives in `core/`
- verify both Freedom Board and Map Editor when behavior is shared
- document technical debt created by any temporary divergence

---

## Immediate Priority Order

1. LAND-path cross-type connectivity in both Freedom Board and Map Editor
2. Attack feature completion, including ranged attacks through objects
3. Script UI, assignment, and persistence
4. Multi-select and commander/follower behavior
5. UUID/runtime asset identity completion
6. WASM feathering pipeline wiring
