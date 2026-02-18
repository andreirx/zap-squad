import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Canvas transform state (camera)
 */
export interface CanvasTransform {
  /** Zoom level (1 = 100%, 2 = 200%, etc.) */
  scale: number;
  /** X offset in screen pixels */
  offsetX: number;
  /** Y offset in screen pixels */
  offsetY: number;
}

export interface UseCanvasTransformOptions {
  /** Initial scale */
  initialScale?: number;
  /** Initial offset */
  initialOffset?: { x: number; y: number };
  /** Minimum scale (default: 0.1) */
  minScale?: number;
  /** Maximum scale (default: 10) */
  maxScale?: number;
  /** Zoom speed multiplier (default: 0.001) */
  zoomSpeed?: number;
  /** Enable panning with middle mouse or space+drag */
  enablePan?: boolean;
  /** Enable wheel zoom */
  enableWheelZoom?: boolean;
}

export interface UseCanvasTransformReturn {
  /** Current transform state */
  transform: CanvasTransform;
  /** Set transform directly */
  setTransform: (t: CanvasTransform) => void;
  /** Convert screen coordinates to world coordinates */
  screenToWorld: (screenX: number, screenY: number) => { x: number; y: number };
  /** Convert world coordinates to screen coordinates */
  worldToScreen: (worldX: number, worldY: number) => { x: number; y: number };
  /** Zoom to a specific point (screen coordinates) */
  zoomToPoint: (screenX: number, screenY: number, newScale: number) => void;
  /** Zoom by a delta amount centered on a point */
  zoomBy: (screenX: number, screenY: number, delta: number) => void;
  /** Pan by a delta amount (screen pixels) */
  panBy: (dx: number, dy: number) => void;
  /** Reset to initial transform */
  reset: () => void;
  /** Fit content to viewport */
  fitToView: (contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number, padding?: number) => void;
  /** Center on a world point */
  centerOn: (worldX: number, worldY: number, viewportWidth: number, viewportHeight: number) => void;
  /** Handlers to attach to canvas container */
  handlers: {
    onWheel: (e: React.WheelEvent) => void;
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseUp: (e: React.MouseEvent) => void;
    onMouseLeave: (e: React.MouseEvent) => void;
  };
  /** Whether currently panning */
  isPanning: boolean;
}

/**
 * Hook for managing canvas pan/zoom with proper zoom-to-point behavior
 *
 * Usage:
 * ```tsx
 * const { transform, handlers, screenToWorld } = useCanvasTransform();
 *
 * <div {...handlers} style={{ overflow: 'hidden' }}>
 *   <canvas style={{
 *     transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
 *     transformOrigin: '0 0',
 *   }} />
 * </div>
 * ```
 */
export function useCanvasTransform(options: UseCanvasTransformOptions = {}): UseCanvasTransformReturn {
  const {
    initialScale = 1,
    initialOffset = { x: 0, y: 0 },
    minScale = 0.1,
    maxScale = 10,
    zoomSpeed = 0.001,
    enablePan = true,
    enableWheelZoom = true,
  } = options;

  const [transform, setTransform] = useState<CanvasTransform>({
    scale: initialScale,
    offsetX: initialOffset.x,
    offsetY: initialOffset.y,
  });

  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const spaceHeldRef = useRef(false);

  // Track space key for space+drag panning
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        spaceHeldRef.current = true;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  /**
   * Convert screen coordinates to world coordinates
   */
  const screenToWorld = useCallback(
    (screenX: number, screenY: number) => {
      return {
        x: (screenX - transform.offsetX) / transform.scale,
        y: (screenY - transform.offsetY) / transform.scale,
      };
    },
    [transform]
  );

  /**
   * Convert world coordinates to screen coordinates
   */
  const worldToScreen = useCallback(
    (worldX: number, worldY: number) => {
      return {
        x: worldX * transform.scale + transform.offsetX,
        y: worldY * transform.scale + transform.offsetY,
      };
    },
    [transform]
  );

  /**
   * Zoom to a specific point, keeping that world point at the same screen position
   *
   * This is the key algorithm:
   * 1. Find what world point is under the mouse
   * 2. After changing scale, calculate offset to keep that point at same screen position
   */
  const zoomToPoint = useCallback(
    (screenX: number, screenY: number, newScale: number) => {
      // Clamp scale
      const clampedScale = Math.max(minScale, Math.min(maxScale, newScale));

      // Step 1: What world point is under the mouse?
      const worldX = (screenX - transform.offsetX) / transform.scale;
      const worldY = (screenY - transform.offsetY) / transform.scale;

      // Step 2: Calculate new offset to keep world point at same screen position
      const newOffsetX = screenX - worldX * clampedScale;
      const newOffsetY = screenY - worldY * clampedScale;

      setTransform({
        scale: clampedScale,
        offsetX: newOffsetX,
        offsetY: newOffsetY,
      });
    },
    [transform, minScale, maxScale]
  );

  /**
   * Zoom by a delta amount (e.g., from wheel event)
   */
  const zoomBy = useCallback(
    (screenX: number, screenY: number, delta: number) => {
      // Use exponential zoom for smooth feel
      const zoomFactor = Math.exp(-delta * zoomSpeed);
      const newScale = transform.scale * zoomFactor;
      zoomToPoint(screenX, screenY, newScale);
    },
    [transform.scale, zoomSpeed, zoomToPoint]
  );

  /**
   * Pan by a delta amount
   */
  const panBy = useCallback((dx: number, dy: number) => {
    setTransform((t) => ({
      ...t,
      offsetX: t.offsetX + dx,
      offsetY: t.offsetY + dy,
    }));
  }, []);

  /**
   * Reset to initial transform
   */
  const reset = useCallback(() => {
    setTransform({
      scale: initialScale,
      offsetX: initialOffset.x,
      offsetY: initialOffset.y,
    });
  }, [initialScale, initialOffset]);

  /**
   * Fit content to viewport with optional padding
   */
  const fitToView = useCallback(
    (contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number, padding = 20) => {
      const availableWidth = viewportWidth - padding * 2;
      const availableHeight = viewportHeight - padding * 2;

      const scaleX = availableWidth / contentWidth;
      const scaleY = availableHeight / contentHeight;
      const newScale = Math.min(scaleX, scaleY, maxScale);

      const scaledWidth = contentWidth * newScale;
      const scaledHeight = contentHeight * newScale;

      setTransform({
        scale: newScale,
        offsetX: (viewportWidth - scaledWidth) / 2,
        offsetY: (viewportHeight - scaledHeight) / 2,
      });
    },
    [maxScale]
  );

  /**
   * Center viewport on a world point
   */
  const centerOn = useCallback(
    (worldX: number, worldY: number, viewportWidth: number, viewportHeight: number) => {
      setTransform((t) => ({
        ...t,
        offsetX: viewportWidth / 2 - worldX * t.scale,
        offsetY: viewportHeight / 2 - worldY * t.scale,
      }));
    },
    []
  );

  // Event handlers
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!enableWheelZoom) return;

      e.preventDefault();

      // Get mouse position relative to container
      const rect = e.currentTarget.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      // Use deltaY for zoom (positive = scroll down = zoom out)
      zoomBy(screenX, screenY, e.deltaY);
    },
    [enableWheelZoom, zoomBy]
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enablePan) return;

      // Middle mouse button OR (left button + space held)
      const shouldPan = e.button === 1 || (e.button === 0 && spaceHeldRef.current);

      if (shouldPan) {
        e.preventDefault();
        setIsPanning(true);
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          offsetX: transform.offsetX,
          offsetY: transform.offsetY,
        };
      }
    },
    [enablePan, transform.offsetX, transform.offsetY]
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning || !panStartRef.current) return;

      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;

      setTransform((t) => ({
        ...t,
        offsetX: panStartRef.current!.offsetX + dx,
        offsetY: panStartRef.current!.offsetY + dy,
      }));
    },
    [isPanning]
  );

  const onMouseUp = useCallback(() => {
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  const onMouseLeave = useCallback(() => {
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  return {
    transform,
    setTransform,
    screenToWorld,
    worldToScreen,
    zoomToPoint,
    zoomBy,
    panBy,
    reset,
    fitToView,
    centerOn,
    handlers: {
      onWheel,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      onMouseLeave,
    },
    isPanning,
  };
}

export default useCanvasTransform;
