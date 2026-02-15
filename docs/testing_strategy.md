# Testing Strategy

## Principle: Off-Target Testing
Core logic MUST be testable without:
- WebAssembly compilation
- Browser environment
- WebGPU context
- External assets

## Test Layers

### 1. Core Tests (`cargo test -p zapsquad-core`)
- Pure unit tests
- No mocking frameworks needed
- Run on native target (x86_64/aarch64)

### 2. Adapter Tests (`cargo test -p zapsquad-adapters`)
- Integration with zap-engine types
- May use test doubles for engine
- Run on native target

### 3. WASM Tests (`cargo test -p zapsquad-wasm --target wasm32-unknown-unknown`)
- Verify WASM compilation succeeds
- Minimal runtime tests (wasm-bindgen-test)

## Test Coverage Requirements
- core/: 90%+ line coverage
- adapters/: 80%+ line coverage
- infrastructure/: Integration tests only

## Running Tests
```bash
make test
```
