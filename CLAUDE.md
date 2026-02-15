# CLAUDE.md - ZapSquad Guidelines

# System Intent (WHY)
This repository contains a high-reliability, safety-critical product. The objective is rock-solid execution, not a Minimum Viable Product. Structural decisions must prioritize long-term maintainability, hardware-independence, and off-target testability.

# Repository Map (WHAT)
The codebase strictly adheres to Clean Architecture principles.
* `core/`: Critical business rules (Entities) and application-specific rules (Use Cases). Highly stable.
* `adapters/`: Interface adapters, gateways, and presenters.
* `infrastructure/`: Volatile details, UI, database implementations, and hardware interfaces.
* `docs/`: Context-specific architectural and operational documentation.

# Execution Protocol (HOW)
* **Verification:** Execute `make test` to verify logic. Core components must execute in isolation without external hardware or database connections.
* **Formatting:** Do not apply code style guidelines or act as a linter. Rely on `make lint` and automated formatters to enforce syntax consistency.
* **Implementation Strategy:** Reuse known-good solutions and standard patterns. Do not reinvent the wheel unless developing proprietary core business logic.

# Clean Architecture Directives (UNIVERSAL RULES)
1. **The Dependency Rule:** Source code dependencies must point strictly inward toward `core/`. Elements in `core/` must never import or reference entities from `adapters/` or `infrastructure/`.
2. **Boundary Enforcement:** Data crossing architectural boundaries must utilize simple Data Transfer Objects (DTOs). Do not pass framework-specific objects, hardware structs, or database rows across boundaries.
3. **Volatility Isolation:** Hardware, databases, and frameworks are volatile external details. Isolate them behind strict abstraction layers (e.g., HAL, OSAL, Gateways).
4. **Architectural Decisions:** When encountering an architectural fork, halt and ask for clarification. Do not unilaterally select an architecture pattern. Provide evidence and explain the underlying mechanics of available options to facilitate a decision.

# Progressive Disclosure Context
Do not assume domain specifics. Read the relevant files below before modifying their associated domains:
* `docs/architecture_decisions.md`: Historical context and existing structural boundaries.
* `docs/hardware_abstraction.md`: Protocols for the HAL and off-target simulation requirements.
* `docs/database_schema.md`: Persistence layer rules and Gateway interface implementations.
* `docs/testing_strategy.md`: Rules for the Test API and decoupled verification.

# Technology Stack
- **Core Logic:** Rust (pure, no external dependencies except std)
- **Game Engine:** zap-engine (external dependency in adapters/)
- **Scripting:** Rhai (WASM-compatible)
- **Level Format:** LDtk JSON
- **Web Runtime:** WASM + WebGPU via zap-web
- **UI:** React + TypeScript


# System Intent (WHY)
This repository contains a high-reliability, safety-critical product. The objective is rock-solid execution, not a Minimum Viable Product. Structural decisions must prioritize long-term maintainability, hardware-independence, and off-target testability. 

# Clean Architecture Directives (UNIVERSAL RULES)
1. **The Dependency Rule:** Source code dependencies must point strictly inward toward `core/`. Elements in `core/` must never import or reference entities from `adapters/` or `infrastructure/`.
2. **Boundary Enforcement:** Data crossing architectural boundaries must utilize simple Data Transfer Objects (DTOs). Do not pass framework-specific objects, hardware structs, or database rows across boundaries.
3. **Volatility Isolation:** Hardware, databases, and frameworks are volatile external details. Isolate them behind strict abstraction layers (e.g., HAL, OSAL, Gateways).
4. **Architectural Decisions:** When encountering an architectural fork, halt and ask for clarification. Do not unilaterally select an architecture pattern. Provide evidence and explain the underlying mechanics of available options to facilitate a decision.

# Progressive Disclosure Context
Do not assume domain specifics. Read the relevant files din docs before modifying their associated domains (and update them when the user input justifies it)
* architecture decisions: Historical context and existing structural boundaries.
* hardware abstractions: Protocols for the HAL and off-target simulation requirements.
* database schema: Persistence layer rules and Gateway interface implementations.
* testing strategy: Rules for the Test API and decoupled verification.
