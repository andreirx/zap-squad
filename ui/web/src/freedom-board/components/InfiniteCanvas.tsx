import { useRef, useEffect, useCallback, useState } from 'react';
import { useZapEngine } from '@zap/web/react';
import type { Tool } from '../types';
import type { TileRegistryEntry } from '../lib/manifest';
import { DebugPanel } from './DebugPanel';
import type { DebugFlags } from './DebugPanel';
import { ASSETS_URL } from '../../lib/config';
import { worldStore, configStore } from '../../lib/idb';
import type { WorldData } from '../../lib/idb';

/** Custom event kinds matching WASM-side `events` module. */
const EVENTS = {
  PLACE_TILE: 1,
  ERASE_TILE: 2,
  SET_TOOL: 3,
  SET_ACTIVE_TILE: 4,
  FLOOD_FILL: 5,
  DRAW_LINE: 6,
  FILL_RECT: 7,
  ERASE_RECT: 8,
  UNDO: 9,
  REDO: 10,
  DRAG_START: 20,
  PLACE_CHARACTER: 30,
  REMOVE_CHARACTER: 31,
  SELECT_CHARACTER: 32,
  MOVE_CHARACTER: 33,
  CAMERA_UPDATE: 100,
  VIEWPORT_SIZE: 101,
  DEBUG_FLAGS: 102,
} as const;

/** Tool name to WASM tool ID. */
const TOOL_IDS: Record<Tool, number> = {
  pan: 0,
  draw: 1,
  erase: 2,
  fill: 3,
  line: 4,
  rect: 5,
  character: 6,
};

/** Engine game world dimensions. Must match GameConfig in lib.rs. */
const GAME_WIDTH = 1920;
const GAME_HEIGHT = 1080;

/** IDB config keys for persisted settings. */
const CONFIG_KEYS = {
  DEBUG_FLAGS: 'freedom-board.debugFlags',
  SAB_LOCK: 'freedom-board.sabLock',
} as const;

/** Bresenham's line algorithm — returns list of integer tile coordinates on the line.
 *  Used for line-tool drag preview. Matches the Rust-side draw_line in core/. */
function bresenhamTiles(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  for (;;) {
    tiles.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    // Safety cap — preview only, no reason to render 1000+ tiles
    if (tiles.length >= 500) break;
  }
  return tiles;
}

/** Derive storage layer from tile type metadata.
 *
 * | tileType | terrainType | Layer | Semantic |
 * |----------|-------------|-------|----------|
 * | TILE     | *           | 0     | Ground   |
 * | PATH     | WATER       | 1     | Rivers   |
 * | BRIDGE   | *           | 2     | Bridges  |
 * | PATH     | LAND        | 3     | Roads    |
 */
export function tileTypeToLayer(entry: TileRegistryEntry | undefined): number {
  if (!entry) return 0;
  if (entry.tileType === 'BRIDGE') return 2;
  if (entry.tileType === 'PATH') {
    return entry.terrainType === 'WATER' ? 1 : 3;
  }
  return 0;
}

interface InfiniteCanvasProps {
  tool: Tool;
  activeAssetId: number;
  activeCharacterId: number;
  tileRegistry: TileRegistryEntry[];
  /** Character ID strings in index order (matches WASM body_def_index). */
  characterNames: string[];
  /** JSON string of a resolved stamp payload, or null. Set by parent when user imports a map. */
  pendingStamp: string | null;
  /** Called after the stamp is dispatched to WASM so parent can clear pendingStamp. */
  onStampComplete: () => void;
  /** JSON string of a full world to import, or null. Set by parent on load-from-disk. */
  pendingWorldImport: string | null;
  /** Called after the world import is dispatched to WASM. */
  onWorldImportComplete: () => void;
  onCursorTileChange: (tile: { x: number; y: number } | null) => void;
  onCameraChange: (camera: { x: number; y: number; zoom: number }) => void;
  onGameEvent: (events: Array<{ kind: number; a: number; b: number; c: number }>) => void;
  /** Called when WASM exports world JSON (for parent to handle save-to-disk). */
  onWorldExport?: (worldData: WorldData) => void;
}

/**
 * Infinite canvas component.
 *
 * Camera model:
 * - cameraX, cameraY: top-left of viewport in tile coordinates (floats).
 * - zoom: game-world-pixels per tile. Default 64.
 *
 * Coordinate systems:
 * - CSS pixels: browser layout coordinates (e.clientX - rect.left).
 * - Game-world pixels: engine's internal coordinate system (GAME_WIDTH x GAME_HEIGHT
 *   base, aspect-preserved to fit container).
 * - Tile coordinates: integer grid positions.
 *
 * The engine uses an aspect-preserving orthographic projection. The uniform
 * scale factor converts CSS pixels to game-world pixels:
 *
 *   scale = GAME_HEIGHT / containerH   (if container is wider than game aspect)
 *   scale = GAME_WIDTH / containerW    (if container is taller)
 *
 * All coordinate math uses this scale factor to stay in the game-world
 * coordinate system, matching the WASM rendering pipeline exactly.
 *
 * Grid, origin crosshair, and debug overlays are rendered by WASM via the
 * engine's vector system (ctx.vectors). React handles only input dispatch
 * and UI chrome (toolbar, status bar, FPS, loading).
 */
export function InfiniteCanvas({
  tool,
  activeAssetId,
  activeCharacterId,
  tileRegistry,
  characterNames,
  pendingStamp,
  onStampComplete,
  pendingWorldImport,
  onWorldImportComplete,
  onCursorTileChange,
  onCameraChange,
  onGameEvent,
  onWorldExport,
}: InfiniteCanvasProps) {
  // ── Camera state (local, sent to WASM on change) ──────────────────
  const cameraRef = useRef({ x: -5, y: -5, zoom: 64 });
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Drag state ────────────────────────────────────────────────────
  const dragRef = useRef<{
    active: boolean;
    isPan: boolean;
    startScreenX: number;
    startScreenY: number;
    startCameraX: number;
    startCameraY: number;
    lastTileX: number;
    lastTileY: number;
  } | null>(null);

  // ── Track whether we've sent the tile registry to WASM ────────────
  const registrySentRef = useRef(false);

  // ── Two-point tool preview (line/rect drag overlay) ─────────────
  const [preview, setPreview] = useState<{
    startX: number; startY: number;
    endX: number; endY: number;
    tool: 'line' | 'rect';
  } | null>(null);

  // ── Debug flags state (loaded from IDB on mount) ───────────────────
  const [debugFlags, setDebugFlags] = useState<DebugFlags>({
    showGrid: true,
    showCrosshair: true,
    showQuadtree: false,
  });

  // ── SAB lock toggle (loaded from IDB on mount) ─────────────────────
  const [useSabLock, setUseSabLock] = useState(false);

  // ── Settings loaded flag (prevents saving defaults before load completes) ──
  const settingsLoadedRef = useRef(false);

  // ── Load persisted settings from IDB on mount ──────────────────────
  useEffect(() => {
    Promise.all([
      configStore.get<DebugFlags>(CONFIG_KEYS.DEBUG_FLAGS),
      configStore.get<boolean>(CONFIG_KEYS.SAB_LOCK),
    ]).then(([savedFlags, savedLock]) => {
      if (savedFlags) setDebugFlags(savedFlags);
      if (savedLock !== undefined) setUseSabLock(savedLock);
      settingsLoadedRef.current = true;
    }).catch(err => {
      console.warn('[freedom-board] failed to load settings from IDB:', err);
      settingsLoadedRef.current = true;
    });
  }, []);

  // ── Persist debug flags to IDB on change ───────────────────────────
  const handleDebugFlagsChange = useCallback((flags: DebugFlags) => {
    setDebugFlags(flags);
    if (settingsLoadedRef.current) {
      configStore.set(CONFIG_KEYS.DEBUG_FLAGS, flags).catch(err =>
        console.warn('[freedom-board] failed to save debug flags:', err)
      );
    }
  }, []);

  // ── Persist SAB lock to IDB on change ──────────────────────────────
  const handleSabLockChange = useCallback((value: boolean) => {
    setUseSabLock(value);
    if (settingsLoadedRef.current) {
      configStore.set(CONFIG_KEYS.SAB_LOCK, value).catch(err =>
        console.warn('[freedom-board] failed to save SAB lock:', err)
      );
    }
  }, []);

  // ── Persistence state ──────────────────────────────────────────────
  // Auto-save: debounce 2 seconds after last world change.
  // Auto-load: on startup after registry is sent to WASM.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTileCountRef = useRef<number>(-1);
  const suppressSaveUntilRef = useRef<number>(0); // suppress save right after load

  // Handle worker messages (world_export response → save to IDB)
  const handleWorkerMessage = useCallback((data: Record<string, unknown>) => {
    if (data.type === 'world_export' && typeof data.json === 'string') {
      try {
        const worldData = JSON.parse(data.json) as WorldData;
        worldStore.save('autosave', worldData).then(() => {
          console.log(`[freedom-board] auto-saved: ${worldData.tiles.length} tiles`);
        });
        // Also notify parent (for save-to-disk flow)
        onWorldExport?.(worldData);
      } catch (err) {
        console.error('[freedom-board] auto-save parse error:', err);
      }
    }
  }, [onWorldExport]);

  // Wrap onGameEvent to detect world changes and schedule saves
  const wrappedGameEvent = useCallback((events: Array<{ kind: number; a: number; b: number; c: number }>) => {
    onGameEvent(events);
    for (const e of events) {
      if (e.kind === 1 && e.a !== lastTileCountRef.current) {
        lastTileCountRef.current = e.a;
        // Don't save right after loading
        if (Date.now() < suppressSaveUntilRef.current) continue;
        // Debounce: save 2 seconds after last change
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          sendEventRef.current({ type: 'export_world' });
        }, 2000);
      }
    }
  }, [onGameEvent]);

  // ── zap-engine hook ───────────────────────────────────────────────
  const { canvasRef, sendEvent, isReady, fps, timing, canvasKey } = useZapEngine({
    wasmUrl: '/src/wasm/freedom_board_wasm.js',
    assetsUrl: `${ASSETS_URL}/assets_feathered.json`,
    assetBasePath: `${ASSETS_URL}/`,
    gameWidth: GAME_WIDTH,
    gameHeight: GAME_HEIGHT,
    force2D: true, // Canvas2D until WebGPU texture size issue is resolved
    onGameEvent: wrappedGameEvent,
    onWorkerMessage: handleWorkerMessage,
    useSabLock,
  });

  // Stable ref for sendEvent (used in timer callback to avoid stale closure)
  const sendEventRef = useRef(sendEvent);
  sendEventRef.current = sendEvent;

  // ── Projection scale factor ─────────────────────────────────────
  //
  // The engine maps GAME_WIDTH x GAME_HEIGHT to the canvas via an
  // aspect-preserving orthographic projection. Because the projection
  // preserves aspect ratio, scaleX == scaleY. This single factor
  // converts CSS pixel distances to game-world pixel distances.
  //
  // Returns: { scale, projW, projH }
  //   scale:  CSS pixels → game-world pixels multiplier
  //   projW:  visible game-world width  (>= GAME_WIDTH)
  //   projH:  visible game-world height (>= GAME_HEIGHT)
  const getProjection = useCallback(() => {
    const el = containerRef.current;
    if (!el) return { scale: 1, projW: GAME_WIDTH, projH: GAME_HEIGHT };
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (cw === 0 || ch === 0) return { scale: 1, projW: GAME_WIDTH, projH: GAME_HEIGHT };

    const containerAspect = cw / ch;
    const gameAspect = GAME_WIDTH / GAME_HEIGHT;

    if (containerAspect > gameAspect) {
      // Container wider than game → height-limited
      const projW = GAME_HEIGHT * containerAspect;
      return { scale: GAME_HEIGHT / ch, projW, projH: GAME_HEIGHT };
    } else {
      // Container taller than game → width-limited
      const projH = GAME_WIDTH / containerAspect;
      return { scale: GAME_WIDTH / cw, projW: GAME_WIDTH, projH };
    }
  }, []);

  // ── Send tile registry + character names to WASM, then load saved world ─
  useEffect(() => {
    if (!isReady || tileRegistry.length === 0 || registrySentRef.current) return;
    registrySentRef.current = true;

    // 1. Send tile/character registry to WASM
    const payload = { tiles: tileRegistry, characters: characterNames };
    sendEvent({ type: 'reload_game_manifest', json: JSON.stringify(payload) });
    console.log(`[freedom-board] sent manifest to WASM: ${tileRegistry.length} tiles, ${characterNames.length} characters`);

    // 2. Load saved world from IndexedDB (if any)
    //    Messages are ordered in the worker queue — registry is processed before import.
    worldStore.load('autosave').then((data) => {
      if (data && data.tiles.length > 0) {
        sendEvent({ type: 'import_world', json: JSON.stringify(data) });
        // Suppress save for 5 seconds to avoid immediately re-saving what we just loaded
        suppressSaveUntilRef.current = Date.now() + 5000;
        console.log(`[freedom-board] loaded autosave: ${data.tiles.length} tiles, ${data.characters.length} characters`);
      }
    }).catch(err => {
      console.error('[freedom-board] auto-load failed:', err);
    });
  }, [isReady, tileRegistry, characterNames, sendEvent]);

  // ── Dispatch pending stamp (map import) to WASM ────────────────────
  useEffect(() => {
    if (!isReady || !pendingStamp) return;
    sendEvent({ type: 'load_level', json: pendingStamp });
    console.log('[freedom-board] stamp dispatched to WASM');
    onStampComplete();
  }, [isReady, pendingStamp, sendEvent, onStampComplete]);

  // ── Dispatch pending world import (load from disk) to WASM ─────────
  useEffect(() => {
    if (!isReady || !pendingWorldImport) return;
    sendEvent({ type: 'import_world', json: pendingWorldImport });
    // Suppress auto-save for 5 seconds to avoid re-saving what we just imported
    suppressSaveUntilRef.current = Date.now() + 5000;
    console.log('[freedom-board] world import dispatched to WASM');
    onWorldImportComplete();
  }, [isReady, pendingWorldImport, sendEvent, onWorldImportComplete]);

  // ── Send debug flags to WASM when they change ──────────────────────
  useEffect(() => {
    if (!isReady) return;
    sendEvent({
      type: 'custom',
      kind: EVENTS.DEBUG_FLAGS,
      a: debugFlags.showGrid ? 1 : 0,
      b: debugFlags.showCrosshair ? 1 : 0,
      c: debugFlags.showQuadtree ? 1 : 0,
    });
  }, [isReady, debugFlags, sendEvent]);

  // ── Send camera state to WASM ─────────────────────────────────────
  const syncCamera = useCallback(() => {
    const cam = cameraRef.current;
    sendEvent({ type: 'custom', kind: EVENTS.CAMERA_UPDATE, a: cam.x, b: cam.y, c: cam.zoom });
    onCameraChange({ x: cam.x, y: cam.y, zoom: cam.zoom });
  }, [sendEvent, onCameraChange]);

  // ── Send viewport size to WASM (in game-world coordinates) ─────────
  const syncViewport = useCallback(() => {
    const { projW, projH } = getProjection();
    sendEvent({
      type: 'custom',
      kind: EVENTS.VIEWPORT_SIZE,
      a: projW,
      b: projH,
      c: 0,
    });
  }, [sendEvent, getProjection]);

  // ── Initial sync when engine is ready ─────────────────────────────
  useEffect(() => {
    if (!isReady) return;
    syncCamera();
    syncViewport();
    sendEvent({ type: 'custom', kind: EVENTS.SET_TOOL, a: TOOL_IDS[tool], b: 0, c: 0 });
  }, [isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync tool changes ─────────────────────────────────────────────
  useEffect(() => {
    if (!isReady) return;
    sendEvent({ type: 'custom', kind: EVENTS.SET_TOOL, a: TOOL_IDS[tool], b: 0, c: 0 });
  }, [tool, isReady, sendEvent]);

  // ── Sync active asset changes ─────────────────────────────────────
  const activeLayer = tileTypeToLayer(tileRegistry[activeAssetId]);

  useEffect(() => {
    if (!isReady) return;
    sendEvent({ type: 'custom', kind: EVENTS.SET_ACTIVE_TILE, a: activeAssetId, b: activeLayer, c: 0 });
  }, [activeAssetId, activeLayer, isReady, sendEvent]);

  // ── Keyboard shortcuts (undo/redo, tool hotkeys) ─────────────────
  useEffect(() => {
    if (!isReady) return;
    const handler = (e: KeyboardEvent) => {
      // Undo: Ctrl+Z (or Cmd+Z on Mac)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        sendEvent({ type: 'custom', kind: EVENTS.UNDO, a: 0, b: 0, c: 0 });
      }
      // Redo: Ctrl+Shift+Z or Ctrl+Y
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || e.key === 'y')) {
        e.preventDefault();
        sendEvent({ type: 'custom', kind: EVENTS.REDO, a: 0, b: 0, c: 0 });
      }
      // Delete/Backspace: remove character at selection (when in character tool)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (tool === 'character') {
          sendEvent({ type: 'custom', kind: EVENTS.REMOVE_CHARACTER, a: 0, b: 0, c: 0 });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isReady, sendEvent, tool]);

  // ── Resize observer ───────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (isReady) syncViewport();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isReady, syncViewport]);

  // ── Cleanup save timer on unmount ─────────────────────────────────
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // ── Screen-to-tile conversion (CSS pixels → tile coords) ─────────
  //
  // Converts CSS pixel position (relative to container) to tile
  // coordinates by first mapping through the projection scale factor
  // into game-world space, then dividing by zoom.
  const screenToTile = useCallback((cssX: number, cssY: number) => {
    const cam = cameraRef.current;
    const { scale } = getProjection();
    const gameX = cssX * scale;
    const gameY = cssY * scale;
    return {
      x: Math.floor(gameX / cam.zoom + cam.x),
      y: Math.floor(gameY / cam.zoom + cam.y),
    };
  }, [getProjection]);

  // ── Tile-to-screen conversion (tile coords → CSS pixels) ──────────
  //
  // Inverse of screenToTile. Returns CSS pixel position of the tile's
  // top-left corner relative to the container element.
  const tileToScreen = useCallback((tileX: number, tileY: number) => {
    const cam = cameraRef.current;
    const { scale } = getProjection();
    return {
      x: (tileX - cam.x) * cam.zoom / scale,
      y: (tileY - cam.y) * cam.zoom / scale,
    };
  }, [getProjection]);

  // ── Clear preview when tool changes (safety) ──────────────────────
  useEffect(() => { setPreview(null); }, [tool]);

  // ── Mouse handlers ────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const tile = screenToTile(sx, sy);

    const isPan = e.button === 1 || (e.button === 0 && tool === 'pan');

    dragRef.current = {
      active: true,
      isPan,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startCameraX: cameraRef.current.x,
      startCameraY: cameraRef.current.y,
      lastTileX: tile.x,
      lastTileY: tile.y,
    };

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    if (!isPan && e.button === 0 && isReady) {
      if (tool === 'draw') {
        sendEvent({ type: 'custom', kind: EVENTS.PLACE_TILE, a: tile.x, b: tile.y, c: activeAssetId });
      } else if (tool === 'erase') {
        sendEvent({ type: 'custom', kind: EVENTS.ERASE_TILE, a: tile.x, b: tile.y, c: activeLayer });
      } else if (tool === 'fill') {
        sendEvent({ type: 'custom', kind: EVENTS.FLOOD_FILL, a: tile.x, b: tile.y, c: activeAssetId });
      } else if (tool === 'line' || tool === 'rect') {
        // Two-point tools: store start on pointer down, complete on pointer up
        sendEvent({ type: 'custom', kind: EVENTS.DRAG_START, a: tile.x, b: tile.y, c: 0 });
        setPreview({ startX: tile.x, startY: tile.y, endX: tile.x, endY: tile.y, tool });
      } else if (tool === 'character') {
        // Left click: place character at tile (WASM auto-selects if one already there).
        // Right click: move selected character (handled by onContextMenu below).
        // Delete/Backspace: remove selected character (handled by keydown listener).
        sendEvent({ type: 'custom', kind: EVENTS.PLACE_CHARACTER, a: tile.x, b: tile.y, c: activeCharacterId });
      }
    }
  }, [tool, activeAssetId, activeCharacterId, activeLayer, isReady, sendEvent, screenToTile]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const tile = screenToTile(sx, sy);

    onCursorTileChange(tile);

    const drag = dragRef.current;
    if (!drag?.active) return;

    if (drag.isPan) {
      // Pan: convert CSS pixel delta to tile delta via projection scale
      const { scale } = getProjection();
      const cam = cameraRef.current;
      const dx = (e.clientX - drag.startScreenX) * scale / cam.zoom;
      const dy = (e.clientY - drag.startScreenY) * scale / cam.zoom;
      cameraRef.current = {
        ...cam,
        x: drag.startCameraX - dx,
        y: drag.startCameraY - dy,
      };
      syncCamera();
    } else if (isReady) {
      if (tile.x !== drag.lastTileX || tile.y !== drag.lastTileY) {
        drag.lastTileX = tile.x;
        drag.lastTileY = tile.y;
        if (tool === 'draw') {
          sendEvent({ type: 'custom', kind: EVENTS.PLACE_TILE, a: tile.x, b: tile.y, c: activeAssetId });
        } else if (tool === 'erase') {
          sendEvent({ type: 'custom', kind: EVENTS.ERASE_TILE, a: tile.x, b: tile.y, c: activeLayer });
        } else if (tool === 'line' || tool === 'rect') {
          setPreview(prev => prev ? { ...prev, endX: tile.x, endY: tile.y } : null);
        }
      }
    }
  }, [tool, activeAssetId, activeLayer, isReady, sendEvent, screenToTile, syncCamera, onCursorTileChange, getProjection]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.active && !drag.isPan && isReady) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const tile = screenToTile(sx, sy);

      if (tool === 'line') {
        sendEvent({ type: 'custom', kind: EVENTS.DRAW_LINE, a: tile.x, b: tile.y, c: activeAssetId });
      } else if (tool === 'rect') {
        sendEvent({ type: 'custom', kind: EVENTS.FILL_RECT, a: tile.x, b: tile.y, c: activeAssetId });
      }
    }
    dragRef.current = null;
    setPreview(null);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [tool, activeAssetId, isReady, sendEvent, screenToTile]);

  const handlePointerLeave = useCallback(() => {
    onCursorTileChange(null);
  }, [onCursorTileChange]);

  // ── Zoom (wheel) ──────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Convert CSS cursor position to game-world position
    const { scale } = getProjection();
    const gameX = sx * scale;
    const gameY = sy * scale;

    const cam = cameraRef.current;
    const oldZoom = cam.zoom;

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.min(512, Math.max(2, oldZoom * factor));

    // Zoom centered on cursor: keep the tile under cursor stationary
    const tileX = gameX / oldZoom + cam.x;
    const tileY = gameY / oldZoom + cam.y;
    const newCamX = tileX - gameX / newZoom;
    const newCamY = tileY - gameY / newZoom;

    cameraRef.current = { x: newCamX, y: newCamY, zoom: newZoom };
    syncCamera();
  }, [syncCamera, getProjection]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onWheel={handleWheel}
      onContextMenu={e => {
        e.preventDefault();
        if (tool === 'character' && isReady) {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const tile = screenToTile(sx, sy);
          sendEvent({ type: 'custom', kind: EVENTS.MOVE_CHARACTER, a: tile.x, b: tile.y, c: 0 });
        }
      }}
    >
      <canvas
        ref={canvasRef}
        key={canvasKey}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          imageRendering: 'pixelated',
        }}
      />

      {/* ── Two-point tool preview overlay (line/rect) ──────────── */}
      {preview && (() => {
        const cam = cameraRef.current;
        const { scale } = getProjection();
        const tilePx = cam.zoom / scale; // CSS pixels per tile

        if (preview.tool === 'rect') {
          const minX = Math.min(preview.startX, preview.endX);
          const minY = Math.min(preview.startY, preview.endY);
          const maxX = Math.max(preview.startX, preview.endX);
          const maxY = Math.max(preview.startY, preview.endY);
          const tl = tileToScreen(minX, minY);
          const w = (maxX - minX + 1) * tilePx;
          const h = (maxY - minY + 1) * tilePx;
          return (
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <rect x={tl.x} y={tl.y} width={w} height={h}
                fill="rgba(233, 69, 96, 0.15)" stroke="rgba(233, 69, 96, 0.6)" strokeWidth={1.5} />
            </svg>
          );
        }

        if (preview.tool === 'line') {
          const cells = bresenhamTiles(preview.startX, preview.startY, preview.endX, preview.endY);
          return (
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {cells.map((t, i) => {
                const pos = tileToScreen(t.x, t.y);
                return (
                  <rect key={i} x={pos.x} y={pos.y} width={tilePx} height={tilePx}
                    fill="rgba(233, 69, 96, 0.15)" stroke="rgba(233, 69, 96, 0.5)" strokeWidth={1} />
                );
              })}
            </svg>
          );
        }

        return null;
      })()}

      {/* Debug/profiling panel — collapsed shows FPS, expanded shows timing + toggles */}
      <DebugPanel
        fps={fps}
        timing={timing}
        debugFlags={debugFlags}
        onDebugFlagsChange={handleDebugFlagsChange}
        useSabLock={useSabLock}
        onSabLockChange={handleSabLockChange}
      />

      {!isReady && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.7)', color: '#e94560', fontSize: 18,
        }}>
          Loading WASM...
        </div>
      )}
    </div>
  );
}
