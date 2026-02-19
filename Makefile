.PHONY: test lint build clean wasm dev check pack-sprites tools-install import-hexmanos bake-atlases

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

# Install tools dependencies
tools-install:
	cd tools && npm install

# Pack sprites into atlases (requires node-canvas)
pack-sprites: tools-install
	cd tools && npx tsx pack-sprites.ts --input ../ui/web/public/mods --output ../ui/web/public/assets

# Build everything
build: wasm pack-sprites

# Development server (hot-reload packs sprites in browser, no need for node tool)
dev: wasm
	cd ui/web && npm run dev

# Full development setup with initial sprite pack
dev-full: build
	cd ui/web && npm run dev

# Import hexmanos assets (requires sharp, no canvas needed)
import-hexmanos:
	cd tools && npm install sharp tsx && npx tsx import-hexmanos.ts --source ~/hexmanos_uploads --output ../ui/web/public/mods --size 128

# Bake sprites into atlases (run after import or editing)
bake-atlases:
	cd tools && npm install sharp tsx && npx tsx bake-atlases.ts --input ../ui/web/public/mods --output ../ui/web/public/assets --size 128

# Clean build artifacts
clean:
	cargo clean
	rm -rf ui/web/pkg
	rm -rf ui/web/dist
	rm -rf ui/web/public/assets/*.png
	rm -rf tools/node_modules
