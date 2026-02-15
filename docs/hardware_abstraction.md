# Hardware Abstraction Layer

## Overview
ZapSquad targets WebGPU via WASM, but core logic must remain hardware-independent.

## Abstraction Boundaries

### Rendering (EngineGateway)
The `EngineGateway` in adapters/ abstracts all rendering operations:
- Core requests "draw entity at position" via DTOs
- Gateway translates to zap-engine sprite/SDF calls
- Core has no knowledge of WebGPU, shaders, or textures

### Input (InputAdapter)
The `InputAdapter` in adapters/ translates platform input:
- WASM receives browser events (pointer, keyboard)
- Adapter converts to core-defined `InputEvent` DTOs
- Core processes abstract input events

### Audio (to be implemented)
Future audio abstraction will follow same pattern:
- Core requests "play sound X"
- Gateway handles WebAudio/native audio backend

## Off-Target Simulation
For testing without browser:
- Mock `EngineGateway` that records draw calls
- Mock `InputAdapter` that injects test events
- All core tests run on native target

## Future Targets
The abstraction layer enables:
- Native desktop via Metal/Vulkan (swap zap-engine backend)
- Mobile via WebGPU or native graphics
- Server-side headless simulation
