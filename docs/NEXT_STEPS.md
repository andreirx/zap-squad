# Next Steps: WASM Integration & Editor/Game Separation

## Current State Summary

### What's Built and Working
- **Editors**: Character, Object, Tile, Map editors - fully functional
- **Canvas2D Rendering**: GameCanvas.tsx renders levels with Canvas2D
- **WASM Binary**: Built and available at `ui/web/pkg/zapsquad_wasm.wasm` (2.9MB)
- **WASM API**: Full TypeScript bindings generated

### What's NOT Connected
- React UI does NOT import or use the WASM module
- zap-engine WebGPU rendering is available but unused
- Hot-reload APIs exist but aren't wired to UI

---

## WASM API (Already Available)

```typescript
// From pkg/zapsquad_wasm.d.ts
import init, {
  game_init,
  game_tick,
  load_level,
  reload_scripts,
  reload_manifest,
  reload_sprite_manifest,
  game_key_down,
  game_key_up,
  game_pointer_down,
  game_pointer_move,
  game_pointer_up,
  get_instances_ptr,
  get_instance_count,
  // ... more getters for render buffers
} from '../pkg/zapsquad_wasm';
```

---

## Phase 1: Connect WASM to Existing UI (Quickest Win) - DONE

### Task 1.1: Create WasmGame Component - DONE
Created `ui/web/src/components/WasmGame.tsx`:
- Loads and initializes WASM module
- Sets up WebGPU context
- Runs game loop with `requestAnimationFrame`
- Forwards keyboard/pointer input to WASM
- Includes reload buttons for scripts and assets

### Task 1.2: Set Up WebGPU Renderer - DONE
Created `ui/web/src/lib/webgpu-renderer.ts`:
- GPU-instanced quad rendering
- Reads instance data directly from WASM memory
- Orthographic camera with pan/zoom
- Sprite atlas support (placeholder for now)
- ~10,000 instances at 60fps

### Task 1.3: Add WASM Game Tab - DONE
- Route: `/game/wasm`
- Full-screen WebGPU canvas
- Level selector dropdown
- FPS counter + instance count
- "Play (WebGPU)" button in navigation

### Next: Sprite Atlas Integration
For sprites to appear, need to:
1. Run `make bake-atlases` to generate sprite atlases
2. Load atlas into WebGPU renderer
3. Call `reload_sprite_manifest()` with atlas metadata

---

## Phase 2: Hot-Reload Integration

### Task 2.1: Wire Script Hot-Reload
```typescript
async function reloadScripts() {
  const storage = createStorage();
  const scripts: Record<string, string> = {};

  // Load all .rhai files
  const files = await storage.list('scripts');
  for (const file of files.filter(f => f.endsWith('.rhai'))) {
    scripts[file] = await storage.readText(`scripts/${file}`);
  }

  wasm.reload_scripts(JSON.stringify(scripts));
}
```

### Task 2.2: Wire Asset Manifest Reload
```typescript
async function reloadManifest() {
  // Build manifest from character/object/tile definitions
  const manifest = await buildGameManifest();
  wasm.reload_manifest(JSON.stringify(manifest));
}
```

### Task 2.3: Add Reload Button to Game UI
Simple button that triggers `reloadScripts()` + `reloadManifest()`.

---

## Phase 3: Editor/Game Separation

### Task 3.1: Create Directory Structure
```
zap-squad/
├── editor/                  # Move current ui/web here
│   └── web/
│       ├── src/
│       │   ├── editors/     # Keep all editors
│       │   ├── components/  # Canvas2D preview components
│       │   └── storage/     # Keep storage layer
│       └── package.json
│
├── game/                    # New game-only app
│   └── web/
│       ├── src/
│       │   ├── WasmGame.tsx
│       │   ├── LevelSelect.tsx
│       │   └── App.tsx
│       └── package.json
```

### Task 3.2: Create Game-Only React App
Minimal React app with:
- WASM loader
- Level selector
- Hot-reload button
- No editors, no Canvas2D fallback

### Task 3.3: Add Editor "Play in Game" Button
Button in Map Editor that opens the game app with the current level.

---

## Phase 4: Authentication Split

### Task 4.1: Editor with Cognito
- Add AWS Amplify to editor app
- Require login for all write operations
- S3 storage with presigned URLs

### Task 4.2: Game as Public App
- Read-only access to public S3/CDN
- No authentication required
- Level data fetched from public URL

---

## Quick Start: Test WASM Now

```bash
# 1. Rebuild WASM (if needed)
make wasm

# 2. Add import to App.tsx (temporary test)
# In ui/web/src/App.tsx, add a test route

# 3. Run dev server
cd ui/web && npm run dev

# 4. Check browser console for WASM init
```

---

## Dependencies & Considerations

### WebGPU Availability
- Chrome 113+ has WebGPU by default
- Firefox needs `dom.webgpu.enabled` flag
- Safari 17+ has WebGPU
- Need Canvas2D fallback for older browsers

### Sprite Atlas
- zap-engine expects sprites in an atlas format
- Need `make bake-atlases` to generate from individual PNGs
- Atlas JSON format documented in zap-engine

### Memory Layout
- WASM exports pointers to instance buffers
- JS reads Float32Arrays from WASM memory
- Instance format: [x, y, w, h, u, v, u2, v2, r, g, b, a, ...]

---

## Recommended Order

1. **Task 1.1-1.3**: Get WASM rendering visible (even if broken)
2. **Task 2.3**: Add reload button to test hot-reload
3. **Task 2.1-2.2**: Wire actual hot-reload
4. **Task 3.1-3.3**: Separate apps (can defer)
5. **Task 4.1-4.2**: Auth (can defer until deployment)

---

## Verification Checklist

- [ ] WASM loads without errors
- [ ] `game_init()` called successfully
- [ ] WebGPU context created
- [ ] Level loads and actors appear
- [ ] Keyboard input works (WASD movement)
- [ ] Hot-reload updates game state
- [ ] Editor and game are separate builds
