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
	wasm-pack build infrastructure/wasm --target web --out-dir ../../ui/web/pkg

# Build everything
build: wasm

# Development server
dev: wasm
	cd ui/web && npm run dev

# Clean build artifacts
clean:
	cargo clean
	rm -rf ui/web/pkg
	rm -rf ui/web/dist
