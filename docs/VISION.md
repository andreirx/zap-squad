# ZapSquad Vision

## Mission

Create a programmable 2D world-building and game-making system for kids, where the same world can be edited, populated, animated, explored as a sandbox, and then turned into a real game by activating authored rules.

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

### 5. Scripting has three scopes, rules shipped first

The scripting model has three isolated scopes:
- **Rules scripts** (`fn on_event(ctx)`) — game-level logic: spawning, resources, win conditions
- **Character AI scripts** (`fn update(ctx)`) — per-character behavior: patrol, chase, attack
- **World gen scripts** (`fn generate(ctx)`) — procedural map setup

The first user-facing scripting milestone delivered was **rules scripting** — the orchestrator
runs rules scripts during Play mode, executing commands that mutate game state. All three
scripting scopes are now live. Character AI uses `AiScriptEngine` with legacy-compatible
function names. World gen runs during session setup via `WorldGenScriptEngine`.

The original plan assumed character behavior would ship first. In practice, rules scripting
was the natural first scope because it validates the entire orchestrator spine: event emission,
script execution, command application, and session lifecycle.

### 5a. Edit and Play are UI modes, not engine states

There is no binary split between editing and playing. The product is a continuous session:

- **Play** starts a `GameSession`. Characters become live domain entities with AI,
  stats, teams, and combat. Rules scripts execute per-event. AI scripts execute per-frame.
- **Pause** is an explicit user action. It freezes the game tick but does not destroy
  the session. The user can inspect state, edit scripts, or switch panels while paused.
- **Edit tools** (draw, erase, fill, character placement) are always available regardless
  of whether the game is running. Switching to an edit tool does NOT pause or stop the game.
  The user can draw tiles while characters are moving.
- **Stop** ends the session and returns characters to inert props on the board.

The implication for scripting:
- Before Play is pressed, characters are inert visual props. No AI executes.
- In sandbox mode, selected AI scripts may be previewed without activating a formal game.
- After Play, characters are live. AI runs every frame while unpaused.
- World gen scripts belong to sandbox/setup only. They are not part of live `GAME ON` execution.
- Switching between edit panels, script editor, and asset browser does not
  interrupt the running game. Play continues in the background.
- A dedicated Pause button exists. It may optionally auto-trigger when switching
  to certain edit modes, but that is a UX preference, not an architectural rule.

This means the engine must support simultaneous editing and gameplay. The board
is both the authoring surface and the runtime surface at all times.

### 5b. Sandbox first, game second

Freedom Board should feel like a playground before it feels like a game engine.

- The default state is a **sandbox**: the user draws terrain, places characters and objects,
  moves things around, and toys with the scene without requiring a formal win/loss structure.
- The UI should clearly separate **authoring controls** (draw, erase, fill, place, assign assets)
  from **play-around controls** (play, pause, inspect, trigger interactions, observe runtime state).
- A "game" is created when the user brings in a **rules package** that says what must exist in the
  sandbox and what becomes enforced once the game is activated.

The intended mental model is playground rules:

- kids first arrange the field, props, players, and boundaries
- then they say what game they are playing
- then the rules become binding and the HUD appears: `GAME ON!`

This means a rules package is not only executable logic. It also needs product-facing metadata:

- **Prerequisites**: what must exist before the game can start
- **Verification function**: inspect the authored world and answer whether the setup is valid
- **Activation semantics**: what changes when the game begins (HUD, scoring, timers, enforced zones, allowed actions)
- **Runtime rules**: event-driven logic once the game is active
- **Failure explanation**: if verification fails, the product must say what is missing

Execution boundaries:

- **Character AI scripts** are valid in both sandbox preview and `GAME ON`
- **Rules scripts** are valid only in `GAME ON`
- **World gen scripts** are valid only in sandbox/setup and are not a live gameplay primitive

This is intentional:

- AI preview lets the user experiment with behavior before committing to a formal game
- rules activation is what turns the sandbox into an enforced game contract
- world gen remains a world-authoring operation, not a runtime gameplay effect

Examples:

- **Soccer** requires enough characters on two teams, a ball object, a play field, and goal zones
- **Laser tag / paintball** requires teams, weapons or tagging rules, arena boundaries, and scoring logic
- **Diablo-like** requires enemies, loot rules, combat rules, and traversal space
- **XCOM-like** requires squad units, hostile units, cover/layout semantics, and turn/phase logic
- **Abstract social or economic simulations** are valid if their hidden state, entities, and rule checks can be modeled explicitly

The engine therefore must support both:

- **spatial prerequisites**: tiles, zones, objects, team placement, boundaries
- **systemic prerequisites**: hidden variables, relation graphs, counters, role assignments, state machines

The product should not assume that "game logic" means only movement and combat. A rule package may define
anything from playground sports to social simulation, provided it can verify its inputs and enforce its rules
through explicit state and commands.

### 5c. Persistence boundary: authored world vs live match state

Freedom Board has two categories of mutation:

- **Authored mutations** — changes made while the game is not active
- **Live match mutations** — changes caused during `GAME ON`

These have different persistence rules.

**While GAME OFF:**

- drawing terrain, placing characters, placing objects, running world gen, and other authoring actions
  modify the authored board state
- these changes are part of the user's intended world and are always persisted

**While GAME ON:**

- the active session may still modify terrain or objects in the future
  (for example: build a bridge, destroy cover, remove an object, open a gate)
- these are runtime gameplay effects, not authoring edits
- they are never written back into the persisted authored world
- when the session stops, the board reverts to the persisted initial state

This means:

- world generation belongs to authored state creation only
- runtime terrain mutation belongs to active game rules/effects only
- stopping play restores the stored authored world, not the mutated match state

The persistence contract must therefore be explicit:

- **GAME OFF edits** are durable by default
- **GAME ON world changes** are ephemeral unless a future feature explicitly introduces a save-the-match-state workflow

### 6. Asset model simplification

Weapons and objects are converging toward a simpler "object asset" model for visuals. Characters may reference melee equipment and ranged/throwable objects, but the product direction is toward fewer overlapping content categories and clearer runtime usage.

---

## Experience Goals

For the kid:
- draw or import tiles and characters
- place them into a world
- play with the scene as a sandbox before committing to a formal game
- assign simple behavior scripts
- choose or author a rules package and see whether the world satisfies its prerequisites
- issue commands to one or many characters
- observe movement, combat, scoring, and interactions immediately once the game is activated

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

Within that model, persisted board state means authored state. Active match state is a transient runtime layer and must not silently overwrite authored storage.

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

1. ~~Script authoring/persistence~~ — DONE: Script Panel, IDB v4 `scripts` store, scoped reload
2. ~~Rules scripting~~ — DONE: orchestrator, Play/Stop lifecycle, rules command application
3. ~~Character script assignment~~ — DONE: CharacterPanel UI, assign_character_script WASM export
4. ~~Runtime asset merge~~ — DONE: seed + IDB overlay, live refresh on save+bake
5. ~~Character AI migration~~ — DONE: AiScriptEngine with legacy-compatible API
6. ~~Pre-flight script validation~~ — DONE: validates rules, world_gen, team AI, per-character AI
7. Play HUD, game activation feedback, and compile/runtime error visibility
8. ~~World generation execution~~ — DONE: WorldGenScriptEngine, tile placement, spawn, zones, snapshot rollback
9. Combat depth (weapon stats, damage formulas, UnitDamaged/UnitKilled events)
10. Multi-select and group commands
11. Commander/follower behavior
12. Sandbox/game control split and prerequisite visualization for rules packages
13. Sandbox AI preview on selected actors without full game activation
14. Runtime terrain/object effects during GAME ON, with explicit non-persistent session rollback

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
- a rules package without prerequisite verification and clear activation/failure feedback is not done
- runtime terrain mutation without a clear persistence boundary is not done

---

## Success Criteria

- A child can place characters into a world and make them do meaningful things with scripts.
- The same world can move from editing to play behavior without format conversion or duplicated logic.
- Terrain and path rendering feel visually coherent without manual transition assets.
- User-created work persists locally, exports cleanly, and imports back without corruption.
- The core rules remain testable off-target and independent of browser/runtime details.
