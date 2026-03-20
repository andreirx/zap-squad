import { useRef, useEffect, useCallback } from 'react';
import { useZapEngine } from '@zap/web/react';
import type { Tool } from '../App';
import type { TileRegistryEntry } from '../lib/manifest';
import { ASSETS_URL } from '../config';

/** Custom event kinds matching WASM-side `events` module. */
const EVENTS = {
  PLACE_TILE: 1,
  ERASE_TILE: 2,
  SET_TOOL: 3,
  SET_ACTIVE_TILE: 4,
  CAMERA_UPDATE: 100,
  VIEWPORT_SIZE: 101,
} as const;

/** Tool name to WASM tool ID. */
const TOOL_IDS: Record<Tool, number> = {
  pan: 0,
  draw: 1,
  erase: 2,
  fill: 3,
};

/** Engine game world dimensions. Must match GameConfig in lib.rs. */
const GAME_WIDTH = 1920;
const GAME_HEIGHT = 1080;

interface InfiniteCanvasProps {
  tool: Tool;
  activeAssetId: number;
  tileRegistry: TileRegistryEntry[];
  onCursorTileChange: (tile: { x: number; y: number } | null) => void;
  onCameraChange: (camera: { x: number; y: number; zoom: number }) => void;
  onGameEvent: (events: Array<{ kind: number; a: number; b: number; c: number }>) => void;
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
  tileRegistry,
  onCursorTileChange,
  onCameraChange,
  onGameEvent,
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

  // ── zap-engine hook ───────────────────────────────────────────────
  const { canvasRef, sendEvent, isReady, fps, canvasKey } = useZapEngine({
    wasmUrl: '/src/wasm/freedom_board_wasm.js',
    assetsUrl: `${ASSETS_URL}/assets.json`,
    assetBasePath: `${ASSETS_URL}/`,
    gameWidth: GAME_WIDTH,
    gameHeight: GAME_HEIGHT,
    force2D: true, // Canvas2D until WebGPU texture size issue is resolved
    onGameEvent: onGameEvent,
  });

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

  // ── Send tile registry to WASM when both engine and manifest are ready ─
  useEffect(() => {
    if (!isReady || tileRegistry.length === 0 || registrySentRef.current) return;
    const json = JSON.stringify(tileRegistry);
    sendEvent({ type: 'reload_game_manifest', json });
    registrySentRef.current = true;
    console.log(`[freedom-board] sent tile registry to WASM: ${tileRegistry.length} tiles`);
  }, [isReady, tileRegistry, sendEvent]);

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
  useEffect(() => {
    if (!isReady) return;
    sendEvent({ type: 'custom', kind: EVENTS.SET_ACTIVE_TILE, a: activeAssetId, b: 0, c: 0 });
  }, [activeAssetId, isReady, sendEvent]);

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
        sendEvent({ type: 'custom', kind: EVENTS.ERASE_TILE, a: tile.x, b: tile.y, c: 0 });
      } else if (tool === 'fill') {
        sendEvent({ type: 'custom', kind: EVENTS.PLACE_TILE, a: tile.x, b: tile.y, c: activeAssetId });
      }
    }
  }, [tool, activeAssetId, isReady, sendEvent, screenToTile]);

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
          sendEvent({ type: 'custom', kind: EVENTS.ERASE_TILE, a: tile.x, b: tile.y, c: 0 });
        }
      }
    }
  }, [tool, activeAssetId, isReady, sendEvent, screenToTile, syncCamera, onCursorTileChange, getProjection]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

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
    const newZoom = Math.min(256, Math.max(4, oldZoom * factor));

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
      onContextMenu={e => e.preventDefault()}
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

      {/* FPS counter — UI chrome, not coordinate-dependent */}
      <div style={{
        position: 'absolute', top: 4, right: 8,
        fontSize: 10, color: '#556677', fontFamily: 'monospace', pointerEvents: 'none',
      }}>
        {fps} FPS
      </div>

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
