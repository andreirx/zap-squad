.PHONY: test lint build clean wasm dev check

# Run all tests (core must pass without WASM)
test:
	cargo test -p zapsquad-core
	cargo test -p zapsquad-adapters

# Check compilation for all targets
check:
	cargo check --workspace
	cargo check -p zapsquad-wasm --target wasm32-unknown-unknown

# Lint with clippy
lint:
	cargo clippy --workspace -- -D warnings

# Build WASM
wasm:
	wasm-pack build infrastructure/wasm --target web --out-dir ../../infrastructure/web/pkg

# Build everything
build: wasm

# Development server (requires web infrastructure)
dev: wasm
	@echo "Web infrastructure not yet set up"

# Clean build artifacts
clean:
	cargo clean
	rm -rf infrastructure/web/pkg
	rm -rf infrastructure/web/dist
