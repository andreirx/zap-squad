# Wasm Infrastructure (`infrastructure/wasm/`)

## Role: The Bridge / Main
This component acts as the glue between the TypeScript-based Web frontend and the Rust-based Core/Adapters. It often fulfills the role of the `Main` component in Clean Architecture, wiring dependencies together.

## Responsibilities
- **Initialization:** Setting up the game loop, initializing the `zap-engine`, and wiring adapters.
- **Communication:** Exposing Rust functions to JavaScript (and vice versa) using `wasm-bindgen`.
- **Loop Management:** driving the game update cycle.

## dependencies
- `zap-squad-core`
- `zap-squad-adapters`
- `zap-engine`
- `wasm-bindgen`
