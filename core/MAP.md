# Core Layer Architecture (`core/`)

## Role: Policy
This is the heart of the application. It contains the business rules and logic that define what the application *is*, independent of how it is presented or stored.

## Strict Rules
1.  **NO External Dependencies:** This layer must NOT depend on `adapters`, `infrastructure`, `zap-engine`, `react`, or any other framework.
2.  **Stable:** Changes here should be rare and driven by business requirements, not technical changes.

## Components

### [Entities](./src/entities/MAP.md)
- **Concept:** Critical Business Rules.
- **Examples:** `GameState`, `Actor`, `Script`.
- **Location:** `src/entities/`

### [Use Cases](./src/use_cases/MAP.md)
- **Concept:** Application Business Rules. Orchestrates the flow of data to and from the entities.
- **Examples:** `Pathfinding`, `GroupMovement`.
- **Location:** `src/use_cases/`

## Testing
- Unit tests here should be fast and run in isolation.
- Mocks should be used for any data interfaces defined here.
