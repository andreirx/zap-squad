.PHONY: test lint build clean wasm wasm-canvas wasm-feather wasm-validator dev dev-canvas check pack-sprites tools-install import-hexmanos bake-atlases

# Run all tests (core must pass without WASM)
test:
	cargo test -p zapsquad-core
	cargo test -p zapsquad-adapters
	cargo test -p wasm-feather
	cargo test -p wasm-validator
	cargo test -p wasm-baker

# Check compilation for all targets
check:
	cargo check --workspace
	cargo check -p zapsquad-wasm --target wasm32-unknown-unknown
	cargo check -p freedom-board-wasm --target wasm32-unknown-unknown
	cargo check -p wasm-feather --target wasm32-unknown-unknown
	cargo check -p wasm-validator --target wasm32-unknown-unknown
	cargo check -p wasm-baker --target wasm32-unknown-unknown

# Lint with clippy
lint:
	cargo clippy --workspace -- -D warnings

# Build WASM for zap-squad game (outputs to ui/web/src/wasm)
wasm:
	wasm-pack build infrastructure/wasm --target web --out-dir ../../ui/web/src/wasm

# Build WASM for feathering atlas processing (outputs to ui/web/src/wasm)
wasm-feather:
	wasm-pack build infrastructure/wasm-feather --target web --out-dir ../../ui/web/src/wasm-feather

# Build WASM for game definition validation (outputs to ui/web)
wasm-validator:
	wasm-pack build infrastructure/wasm-validator --target web --out-dir ../../ui/web/src/wasm-validator

# Build WASM for asset baking (outputs to ui/web)
wasm-baker:
	wasm-pack build infrastructure/wasm-baker --target web --out-dir ../../ui/web/src/wasm-baker

# Build WASM for freedom-board canvas (outputs to both ui/canvas and ui/web)
wasm-canvas:
	wasm-pack build infrastructure/wasm-canvas --target web --out-dir ../../ui/canvas/src/wasm
	cp ui/canvas/src/wasm/freedom_board_wasm.js ui/web/src/wasm/
	cp ui/canvas/src/wasm/freedom_board_wasm.d.ts ui/web/src/wasm/
	cp ui/canvas/src/wasm/freedom_board_wasm_bg.wasm ui/web/src/wasm/
	cp ui/canvas/src/wasm/freedom_board_wasm_bg.wasm.d.ts ui/web/src/wasm/

# Install tools dependencies
tools-install:
	cd tools && npm install

# Pack sprites into atlases (requires node-canvas)
pack-sprites: tools-install
	cd tools && npx tsx pack-sprites.ts --input ../ui/web/public/mods --output ../ui/web/public/assets

# Build everything
build: wasm wasm-canvas wasm-feather wasm-validator wasm-baker pack-sprites

# Development server (unified app with freedom-board + editors)
dev: wasm wasm-canvas wasm-validator wasm-baker
	cd ui/web && npm run dev

# Freedom-board dev server
dev-canvas: wasm-canvas
	cd ui/canvas && npm run dev

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
	rm -rf ui/web/src/wasm
	rm -rf ui/web/src/wasm-feather
	rm -rf ui/web/src/wasm-validator
	rm -rf ui/canvas/src/wasm
	rm -rf ui/web/dist
	rm -rf ui/canvas/dist
	rm -rf ui/web/public/assets/*.png
	rm -rf tools/node_modules
