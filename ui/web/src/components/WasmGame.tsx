/**
 * WasmGame — uses the official useZapEngine hook from @zap/web/react.
 *
 * Architecture:
 *  - Canvas size = viewport (container) size, NOT level size
 *  - Camera position passed to WASM for viewport culling
 *  - WASM renders only visible tiles, offset by camera
 *  - Pan: right-click drag or space+drag
 *  - Zoom: scroll wheel (zooms to cursor)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useZapEngine } from '@zap/web/react';
import { createStorage } from '../storage';

// URL to the zap-squad WASM JS glue file
import wasmModuleUrl from '../wasm/zapsquad_wasm.js?url';
const WASM_URL = wasmModuleUrl;

// zap-engine format sprite manifest (atlases + sprites)
const ASSETS_URL = '/assets/assets.json';

// Game manifest with tile definitions
const MANIFEST_URL = '/assets/manifest.json';

// Maximum canvas size to prevent WebGPU texture limits
// WebGPU default limit is 8192, we use 4096 for safety margin
const MAX_CANVAS_SIZE = 4096;

interface WasmGameProps {
  levelId?: string;
  onError?: (error: string) => void;
}

/** Inner component that renders after level size is known */
function WasmGameInner({
  levelId,
  levelSize,
  levelJson,
  onError
}: {
  levelId: string;
  levelSize: { width: number; height: number };
  levelJson: string;
  onError?: (error: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Camera state: position in world coordinates + zoom
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const spaceHeldRef = useRef(false);

  // Compute canvas size (capped to prevent WebGPU issues)
  const canvasWidth = Math.min(viewportSize.width, MAX_CANVAS_SIZE);
  const canvasHeight = Math.min(viewportSize.height, MAX_CANVAS_SIZE);

  const { canvasRef, sendEvent, fps, isReady, canvasKey } = useZapEngine({
    wasmUrl: WASM_URL,
    assetsUrl: ASSETS_URL,
    gameWidth: canvasWidth,
    gameHeight: canvasHeight,
  });

  // Track container size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };

    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // Track space key for space+drag panning
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) spaceHeldRef.current = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Send camera position to WASM when it changes
  useEffect(() => {
    if (!isReady) return;
    // Custom event type 100 = camera update
    // Pass: camX, camY, zoom, viewportW, viewportH
    sendEvent({
      type: 'custom',
      kind: 100,
      a: camera.x,
      b: camera.y,
      c: camera.zoom,
    });
    // Also send viewport size
    sendEvent({
      type: 'custom',
      kind: 101,
      a: canvasWidth / camera.zoom,
      b: canvasHeight / camera.zoom,
      c: 0,
    });
  }, [isReady, camera, canvasWidth, canvasHeight, sendEvent]);

  // Native wheel listener with passive: false
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Zoom to cursor
      const zoomFactor = Math.exp(-e.deltaY * 0.002);
      const newZoom = Math.max(0.1, Math.min(5, camera.zoom * zoomFactor));

      // World point under cursor
      const worldX = camera.x + mouseX / camera.zoom;
      const worldY = camera.y + mouseY / camera.zoom;

      // New camera position keeps that world point at same screen position
      const newX = worldX - mouseX / newZoom;
      const newY = worldY - mouseY / newZoom;

      setCamera({ x: newX, y: newY, zoom: newZoom });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [camera]);

  // Pan handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2 || (e.button === 0 && spaceHeldRef.current)) {
      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, camX: camera.x, camY: camera.y };
    }
  }, [camera.x, camera.y]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !panStartRef.current) return;
    const dx = (e.clientX - panStartRef.current.x) / camera.zoom;
    const dy = (e.clientY - panStartRef.current.y) / camera.zoom;
    setCamera(c => ({ ...c, x: panStartRef.current!.camX - dx, y: panStartRef.current!.camY - dy }));
  }, [isPanning, camera.zoom]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  // Fit level to view on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fitToView = () => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const padding = 40;
      const scaleX = (rect.width - padding * 2) / levelSize.width;
      const scaleY = (rect.height - padding * 2) / levelSize.height;
      const zoom = Math.min(scaleX, scaleY, 1);

      // Center the level
      const x = (levelSize.width - rect.width / zoom) / 2;
      const y = (levelSize.height - rect.height / zoom) / 2;
      setCamera({ x: Math.max(0, x), y: Math.max(0, y), zoom });
    };

    // Delay to ensure container has size
    requestAnimationFrame(fitToView);
  }, [levelSize]);

  // Load game manifest once engine is ready
  useEffect(() => {
    if (!isReady) return;

    let cancelled = false;

    async function loadManifest() {
      try {
        console.log('[WasmGame] Loading game manifest...');
        const response = await fetch(MANIFEST_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.text();
        if (cancelled) return;
        console.log(`[WasmGame] Sending game manifest to worker (${json.length} chars)`);
        sendEvent({ type: 'reload_game_manifest', json });
      } catch (e) {
        console.error('[WasmGame] Failed to load manifest:', e);
      }
    }

    loadManifest();
    return () => { cancelled = true; };
  }, [isReady, sendEvent]);

  // Send level JSON to worker once engine is ready
  useEffect(() => {
    if (!isReady || !levelJson) return;
    console.log(`[WasmGame] Sending level JSON to worker (${levelJson.length} chars)`);
    sendEvent({ type: 'load_level', json: levelJson });
  }, [isReady, levelJson, sendEvent]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#0a0a15',
        overflow: 'hidden',
        cursor: isPanning ? 'grabbing' : 'default',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Canvas fills the container */}
      <canvas
        key={canvasKey}
        ref={canvasRef}
        style={{
          width: canvasWidth,
          height: canvasHeight,
          display: 'block',
          imageRendering: 'pixelated',
        }}
      />

      {/* HUD overlay */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 12,
          color: 'rgba(255,255,255,0.6)',
          fontFamily: 'monospace',
          fontSize: 12,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 4,
        }}
      >
        <span>{isReady ? `${fps} FPS` : 'Loading…'}</span>
        <span>{Math.round(camera.zoom * 100)}%</span>
      </div>

      {/* Controls hint */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: 12,
          color: 'rgba(255,255,255,0.4)',
          fontFamily: 'monospace',
          fontSize: 10,
          pointerEvents: 'none',
        }}
      >
        Scroll: zoom • Right-drag: pan • Space+drag: pan
      </div>
    </div>
  );
}

/** Outer component that loads level dimensions before initializing engine */
export function WasmGame({ levelId, onError }: WasmGameProps) {
  const [levelData, setLevelData] = useState<{
    json: string;
    size: { width: number; height: number };
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load level JSON to get dimensions before initializing engine
  useEffect(() => {
    if (!levelId) {
      setLevelData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function loadLevel() {
      try {
        const storage = createStorage();
        console.log(`[WasmGame] Pre-loading level: ${levelId}`);
        const json = await storage.readText(`levels/${levelId}.json`);
        if (cancelled) return;

        // Parse to get dimensions
        const parsed = JSON.parse(json);
        const level = parsed.levels?.[0];
        const size = {
          width: level?.pxWid || 2048,
          height: level?.pxHei || 2048,
        };

        console.log(`[WasmGame] Level size: ${size.width}x${size.height}`);
        setLevelData({ json, size });
      } catch (e) {
        console.error('[WasmGame] Failed to load level:', e);
        setError(`Failed to load level: ${e}`);
        onError?.(`Failed to load level: ${e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadLevel();
    return () => { cancelled = true; };
  }, [levelId, onError]);

  if (loading || !levelId) {
    return (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a15',
        color: 'rgba(255,255,255,0.6)',
        fontFamily: 'monospace',
      }}>
        {loading ? 'Loading level...' : 'Select a level'}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a15',
        color: '#ff6b6b',
        fontFamily: 'monospace',
      }}>
        {error}
      </div>
    );
  }

  if (!levelData) {
    return null;
  }

  // Key forces remount when level changes
  return (
    <WasmGameInner
      key={levelId}
      levelId={levelId}
      levelSize={levelData.size}
      levelJson={levelData.json}
      onError={onError}
    />
  );
}
