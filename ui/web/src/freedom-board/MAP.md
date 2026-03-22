# Freedom Board Module

## What
Infinite canvas world editor and gameplay runtime. Users place tiles, characters, and import LDtk maps onto a sparse infinite grid. Uses feathered 160x160 atlases for smooth tile-to-tile blending.

## Architecture Connection
- **Route**: `/` (home) in the unified web app
- **WASM**: Loads `freedom-board-wasm` crate (separate from `zapsquad-wasm`)
- **Persistence**: IndexedDB via shared `lib/idb.ts` (auto-save + explicit save/load to disk)
- **Settings**: Debug panel state persisted in IDB `config` store
- **Assets**: Loads `manifest.json` + feathered atlas PNGs from `/assets/`

## File Map
```
FreedomBoardPage.tsx    Route component — toolbar, asset panel, canvas, status bar
types.ts                Tool and WorldStats type exports
components/
  InfiniteCanvas.tsx    WASM engine integration, camera, input, persistence
  DebugPanel.tsx        FPS, timing bars, debug overlay toggles, SAB lock
  AssetPanel.tsx        Tile/character/weapon browser with sprite previews
  StatusBar.tsx         Cursor position, camera state, world stats
  FBToolbar.tsx         Drawing tools, import map, save/load to disk
lib/
  manifest.ts           Manifest.json loader, tile/character/weapon definitions
```

## Dependencies
- `../../lib/idb.ts` — shared IndexedDB persistence
- `../../lib/config.ts` — ASSETS_URL configuration
- `@zap/web/react` — useZapEngine hook, TimingBars component
- WASM at `/src/wasm/freedom_board_wasm.js`
