# Architecture Decisions

## ADR-001: Clean Architecture Foundation
**Date:** 2026-02-11
**Status:** Accepted

### Context
ZapSquad is designed to be a high-reliability game engine for educational use.

### Decision
Adopt Clean Architecture with strict layer separation:
- core/ contains pure business logic (no framework deps)
- adapters/ bridges core to external systems
- infrastructure/ contains volatile external details

### Consequences
- Core logic fully testable without WASM/browser
- zap-engine is an implementation detail, swappable
- Slightly more boilerplate for boundary crossing

---

## ADR-002: zap-engine as Rendering Backend
**Date:** 2026-02-11
**Status:** Accepted

### Context
Need WebGPU rendering with HDR support.

### Decision
Use zap-engine via adapter layer, not direct integration.

### Consequences
- Rendering is isolated behind EngineGateway
- Core doesn't know about sprites, shaders, etc.
- Future: could swap for native Metal/Vulkan backend

---

## ADR-003: Rhai for Scripting
**Date:** 2026-02-11
**Status:** Accepted

### Context
Kids need a simple, safe scripting language.

### Decision
Use Rhai (Rust-native, WASM-compatible, sandboxed).

### Consequences
- Simple syntax accessible to beginners
- No filesystem/network access (safe sandbox)
- Script execution happens in adapters layer
