# Entities (`core/src/entities/`)

## Role: Critical Business Rules
These are the fundamental objects of the domain. They encapsulate the state and behavior of the game world.

## Key Entities
- **GameState**: The source of truth for the entire game session.
- **Actor**: Represents a character or object in the world.
- **Level**: Defines the static environment.
- **Script**: Logic definitions for actor behaviors.

## Constraints
- Must not know about the database (e.g., no SQL annotations).
- Must not know about the UI (e.g., no HTML/CSS references).
