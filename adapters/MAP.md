# Adapters Layer (`adapters/`)

## Role: Interface Adapters
This layer converts data from the format most convenient for the use cases and entities, to the format most convenient for some external agency such as the Database or the Web. It is a set of adapters that convert data between the core and the outside world.

## Dependencies
- **Depends on:** `core` (Entities and Use Cases).
- **Used by:** `infrastructure`.

## Components
- **AssetGateway**: Interfaces with the asset loading mechanism (which is implemented in Infrastructure).
- **EngineGateway**: Adapts the `zap-engine` functionality to be used by the Core.
- **CompositeRenderer**: Handles rendering logic, adapting core game state to visual representation.
- **InputAdapter**: Translates raw input events into game commands.

## Architecture Rules
- No direct dependency on the Web Framework (React).
- No direct dependency on the Database Driver (if any).
- Implements interfaces defined in the `core` (Dependency Inversion).
