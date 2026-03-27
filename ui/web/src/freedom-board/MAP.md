# Freedom Board Module

## What
Infinite canvas world editor and gameplay runtime. Users place tiles, characters, and import LDtk maps onto a sparse infinite grid. Uses feathered 160x160 atlases for smooth tile-to-tile blending.

## Architecture Connection
- **Route**: `/` (home) in the unified web app
- **WASM**: Loads `freedom-board-wasm` crate (separate from `zapsquad-wasm`)
- **Persistence**: IndexedDB via shared `lib/idb.ts` (auto-save + explicit save/load to disk)
- **Settings**: Debug panel state persisted in IDB `config` store
- **Assets**:
  - Seed metadata from `/assets/manifest.json`
  - Seed runtime registry from `/assets/assets_feathered.json`
  - User-authored character source definitions loaded through `createStorage()` from logical `characters/...` paths, physically stored in IDB under `mods/characters/...` by the default adapter
  - User-baked runtime atlases/registry from IDB `baked/characters/...`
  - Runtime merge via `lib/asset-registry-merge.ts` — combines seed manifest with IDB baked overlays into a single bootable runtime view for zap-engine

## Runtime Asset Model
The runtime uses a **layered** asset model:
1. **Seed base layer**: `/assets/assets_feathered.json` + static atlas PNGs from disk/S3/CDN
2. **IDB overlay layer**: baked character atlases from `baked/characters/...` in IndexedDB
3. **Merged view**: `loadMergedRegistry()` produces one manifest + blob map consumed by `useZapEngine`

The engine's `loadAssetBlobs()` accepts pre-loaded blobs and skips network fetches for atlas names already provided. This allows IDB-backed baked atlases to participate in engine init without fake fetches.

### Live Refresh
- CharacterEditor save+bake emits `character-assets-changed` event
- FreedomBoardPage reloads the sidebar catalog on this event
- InfiniteCanvas reloads the merged runtime registry on this event
- Generation counter prevents stale async results from overwriting newer data
- Engine restarts with updated manifest + atlas blobs when baked set changes

### Inclusion Rules
- **Source authority:** `CharacterSourceDef` is authoritative for identity and equipment
- **Board inclusion:** user characters appear in the sidebar only when both source definition and baked outputs exist
- **Duplicate-id safety:** if a user character id collides with a seed character id, the seed entry wins and the user entry is skipped

## File Map
```
FreedomBoardPage.tsx    Route component — toolbar, asset panel, canvas, status bar
types.ts                Tool and WorldStats type exports
components/
  InfiniteCanvas.tsx    WASM engine integration, camera, input, persistence, runtime merge
  DebugPanel.tsx        FPS, timing bars, debug overlay toggles, SAB lock
  AssetPanel.tsx        Tile/character/weapon browser with sprite previews
  StatusBar.tsx         Cursor position, camera state, world stats
  FBToolbar.tsx         Drawing tools, import map, save/load to disk
  ScriptPanel.tsx       Script editor sidebar (Rhai scripts, 3 scopes)
  RhaiEditor.tsx        CodeMirror 6 editor wrapper for Rhai scripts
  CharacterPanel.tsx    Selected character info + script assignment
lib/
  manifest.ts           Freedom Board asset catalog loader (seed + ready user characters)
  asset-events.ts       UI-level refresh events for save+bake cycles
```

## Dependencies
- `../../lib/idb.ts` — shared IndexedDB persistence
- `../../lib/config.ts` — ASSETS_URL configuration
- `../../lib/asset-registry-merge.ts` — seed + IDB baked overlay merge
- `../../lib/asset-events.ts` — character-assets-changed event subscribe
- `@zap/web/react` — useZapEngine hook, TimingBars component
- WASM at `/src/wasm/freedom_board_wasm.js`

## Known Technical Debt
- **No delete event**: character deletion does not emit `character-assets-changed`. A deleted baked character remains in the runtime overlay until page reload.
- **No baked cache purge**: deleting a source definition does not automatically remove its baked outputs from IDB. Stale baked artifacts may persist.
- **Normal map parity**: `loadNormalMapBlobs()` does not yet accept pre-loaded blobs. If overlay atlases ever carry normal maps, the same layered pattern must be applied.
- **Engine restart on re-bake**: re-baking an existing character triggers a full engine teardown + restart. Hot-patching a single atlas without restart is not implemented.
