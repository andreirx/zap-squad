# Zap Squad Architecture Map

## Overview
Zap Squad is a game project built with a Clean Architecture approach. Ideally, the system is decomposed into functional realities (Core) and external variables (Infrastructure).

## Architectural Layers

### 1. Core (Policies) -> `core/`
- **Role:** The "Brain". Contains the Critical Business Rules (Entities) and Application Business Rules (Use Cases).
- **Volatility:** Low. These rules should not change due to UI or Database changes.
- **Dependencies:** **MUST NOT** depend on anything outside of `core`.
- **Key Components:**
    - `Entities`: `GameState`, `Actor`, `Level`.
    - `Use Cases`: `Pathfinding`, `GroupMovement`.

### 2. Adapters (Interface Adapters) -> `adapters/`
- **Role:** The "Translator". Converts data from the format most convenient for the Use Cases and Entities, to the format most convenient for some external agency such as the Database or the Web.
- **Volatility:** Medium.
- **Dependencies:** Depends strictly on `core`.
- **Key Components:**
    - `AssetGateway`: Loads assets.
    - `EngineGateway`: Interfaces with the game engine (`zap-engine`).
    - `CompositeRenderer`: Renders game state.

### 3. UI (Presentation) -> `ui/`
- **Role:** The "Face". Contains the Web Client, Editors, and any user-facing logic.
- **Volatility:** High.
- **Dependencies:** Depends on `infrastructure` (for Wasm bridge) and `adapters`.
- **Key Components:**
    - `web`: The React/Vite application.
    - `editors`: Level editors, Character editors.

### 4. Infrastructure (Details) -> `infrastructure/`
- **Role:** The "Plumbing". Low-level details, Wasm bridge, OSAL.
- **Volatility:** High.
- **Dependencies:** Depends on `adapters`.
- **Key Components:**
    - `wasm`: The WebAssembly bridge.
    - `zap-engine`: The game engine library.

## Dependency Rule
**Source code dependencies must point strictly inward.**
`UI` -> `Adapters`/`Infrastructure` -> `Adapters` -> `Core`

## Navigation
- [Core Architecture](./core/MAP.md)
- [Adapters Architecture](./adapters/MAP.md)
- [UI Architecture](./ui/MAP.md)
- [Infrastructure Architecture](./infrastructure/MAP.md)
