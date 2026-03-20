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
 * - zoom: pixels per tile on screen. Default 64 = each tile is 64x64 CSS px.
 *
 * Screen-to-tile conversion:
 *   tileX = screenX / zoom + cameraX
 *   tileY = screenY / zoom + cameraY
 *
 * Pan: middle-mouse drag, or any drag when tool=pan.
 * Zoom: scroll wheel, centered on cursor position.
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
    gameWidth: 1920,
    gameHeight: 1080,
    force2D: true, // Canvas2D until WebGPU texture size issue is resolved
    onGameEvent: onGameEvent,
  });

  // ── Send tile registry to WASM when both engine and manifest are ready ─
  // Uses 'reload_game_manifest' message type — the engine worker dispatches
  // this to the wasm reload_game_manifest() export. For freedom-board, the
  // "game manifest" is the tile registry JSON array.
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

  // ── Send viewport size to WASM ────────────────────────────────────
  const syncViewport = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    sendEvent({
      type: 'custom',
      kind: EVENTS.VIEWPORT_SIZE,
      a: el.clientWidth,
      b: el.clientHeight,
      c: 0,
    });
  }, [sendEvent]);

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

  // ── Screen-to-tile conversion ─────────────────────────────────────
  const screenToTile = useCallback((screenX: number, screenY: number) => {
    const cam = cameraRef.current;
    return {
      x: Math.floor(screenX / cam.zoom + cam.x),
      y: Math.floor(screenY / cam.zoom + cam.y),
    };
  }, []);

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
      const cam = cameraRef.current;
      const dx = (e.clientX - drag.startScreenX) / cam.zoom;
      const dy = (e.clientY - drag.startScreenY) / cam.zoom;
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
  }, [tool, activeAssetId, isReady, sendEvent, screenToTile, syncCamera, onCursorTileChange]);

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

    const cam = cameraRef.current;
    const oldZoom = cam.zoom;

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.min(256, Math.max(4, oldZoom * factor));

    // Zoom centered on cursor position
    const tileX = sx / oldZoom + cam.x;
    const tileY = sy / oldZoom + cam.y;
    const newCamX = tileX - sx / newZoom;
    const newCamY = tileY - sy / newZoom;

    cameraRef.current = { x: newCamX, y: newCamY, zoom: newZoom };
    syncCamera();
  }, [syncCamera]);

  // ── Grid overlay ──────────────────────────────────────────────────
  const cam = cameraRef.current;
  const gridSize = cam.zoom;
  const gridOffsetX = -(cam.x % 1) * gridSize;
  const gridOffsetY = -(cam.y % 1) * gridSize;

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

      {gridSize >= 16 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: `
              linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)
            `,
            backgroundSize: `${gridSize}px ${gridSize}px`,
            backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px`,
          }}
        />
      )}

      {/* Origin crosshair */}
      <div style={{
        position: 'absolute', left: -cam.x * gridSize, top: 0,
        width: 1, height: '100%',
        background: 'rgba(233, 69, 96, 0.3)', pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', left: 0, top: -cam.y * gridSize,
        width: '100%', height: 1,
        background: 'rgba(233, 69, 96, 0.3)', pointerEvents: 'none',
      }} />

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
