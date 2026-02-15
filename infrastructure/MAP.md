# Infrastructure Layer (`infrastructure/`)

## Role: Frameworks and Drivers
This is the outermost layer. It contains frameworks and tools such as the Database, the Web Framework, etc. generally, you don’t write much code in this layer other than glue code that communicates to the next circle inwards.

## Dependencies
- **Depends on:** `adapters`.
- **Note:** It can instantiate `core` objects but only through `adapters` or strict factories.

## Sub-layers
## Sub-layers

### [Wasm](./wasm/MAP.md)
The WebAssembly bridge. It acts as the `Main` component in many aspects, wiring the `core` logic to the `web` frontend.

## External Systems
- **zap-engine**: The game engine library.
