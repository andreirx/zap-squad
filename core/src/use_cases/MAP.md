# Use Cases (`core/src/use_cases/`)

## Role: Application Business Rules
This layer contains application-specific business rules. It encapsulates and implements all of the use cases of the system.

## Key Use Cases
- **Pathfinding**: meaningful movement calculation.
- **GroupMovement**: Coordinating multiple actors.

## Interaction
- Receives input from `Adapters`.
- Manipulates `Entities`.
- Returns Output Data to `Adapters`.
