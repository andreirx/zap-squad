import { useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useCanvasTransform, type UseCanvasTransformOptions } from '../hooks/useCanvasTransform';

export interface PanZoomCanvasProps extends UseCanvasTransformOptions {
  /** Canvas width in world units */
  width: number;
  /** Canvas height in world units */
  height: number;
  /** Background color */
  backgroundColor?: string;
  /** Show grid */
  showGrid?: boolean;
  /** Grid size in world units */
  gridSize?: number;
  /** Grid color */
  gridColor?: string;
  /** Children rendered inside the transformed container */
  children?: ReactNode;
  /** Render callback for drawing on the canvas */
  onRender?: (ctx: CanvasRenderingContext2D, transform: { scale: number; offsetX: number; offsetY: number }) => void;
  /** Mouse move callback with world coordinates */
  onWorldMouseMove?: (worldX: number, worldY: number, screenX: number, screenY: number) => void;
  /** Mouse click callback with world coordinates */
  onWorldClick?: (worldX: number, worldY: number, button: number) => void;
  /** Called when transform changes */
  onTransformChange?: (transform: { scale: number; offsetX: number; offsetY: number }) => void;
  /** CSS class for container */
  className?: string;
  /** CSS style for container */
  style?: React.CSSProperties;
}

/**
 * Infinite canvas component with pan/zoom
 *
 * Features:
 * - Wheel to zoom (centers on cursor)
 * - Middle mouse or Space+drag to pan
 * - Optional grid overlay
 * - Coordinate conversion utilities
 *
 * Usage:
 * ```tsx
 * <PanZoomCanvas
 *   width={800}
 *   height={600}
 *   showGrid
 *   gridSize={32}
 *   onRender={(ctx, transform) => {
 *     // Draw your content here
 *     ctx.fillRect(0, 0, 100, 100);
 *   }}
 *   onWorldClick={(x, y) => {
 *     console.log('Clicked at world:', x, y);
 *   }}
 * />
 * ```
 */
export function PanZoomCanvas({
  width,
  height,
  backgroundColor = '#1a1a2e',
  showGrid = false,
  gridSize = 32,
  gridColor = 'rgba(255, 255, 255, 0.1)',
  children,
  onRender,
  onWorldMouseMove,
  onWorldClick,
  onTransformChange,
  className,
  style,
  ...transformOptions
}: PanZoomCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const {
    transform,
    handlers,
    screenToWorld,
    isPanning,
    fitToView,
  } = useCanvasTransform(transformOptions);

  // Notify parent of transform changes
  useEffect(() => {
    onTransformChange?.(transform);
  }, [transform, onTransformChange]);

  // Fit to view on mount
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      fitToView(width, height, rect.width, rect.height);
    }
  }, [width, height, fitToView]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const render = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // Resize canvas if needed
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        ctx.scale(dpr, dpr);
      }

      // Clear
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, rect.width, rect.height);

      // Apply transform
      ctx.save();
      ctx.translate(transform.offsetX, transform.offsetY);
      ctx.scale(transform.scale, transform.scale);

      // Draw world background
      ctx.fillStyle = '#0f0f23';
      ctx.fillRect(0, 0, width, height);

      // Draw grid
      if (showGrid && transform.scale > 0.2) {
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1 / transform.scale;

        // Only draw visible grid lines
        const viewLeft = -transform.offsetX / transform.scale;
        const viewTop = -transform.offsetY / transform.scale;
        const viewRight = viewLeft + rect.width / transform.scale;
        const viewBottom = viewTop + rect.height / transform.scale;

        const startX = Math.floor(Math.max(0, viewLeft) / gridSize) * gridSize;
        const startY = Math.floor(Math.max(0, viewTop) / gridSize) * gridSize;
        const endX = Math.min(width, viewRight);
        const endY = Math.min(height, viewBottom);

        ctx.beginPath();
        for (let x = startX; x <= endX; x += gridSize) {
          ctx.moveTo(x, Math.max(0, viewTop));
          ctx.lineTo(x, Math.min(height, viewBottom));
        }
        for (let y = startY; y <= endY; y += gridSize) {
          ctx.moveTo(Math.max(0, viewLeft), y);
          ctx.lineTo(Math.min(width, viewRight), y);
        }
        ctx.stroke();
      }

      // Draw world border
      ctx.strokeStyle = '#4ecca3';
      ctx.lineWidth = 2 / transform.scale;
      ctx.strokeRect(0, 0, width, height);

      // Custom render callback
      if (onRender) {
        onRender(ctx, transform);
      }

      ctx.restore();

      // Draw zoom indicator
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '12px monospace';
      ctx.fillText(`${Math.round(transform.scale * 100)}%`, 10, rect.height - 10);

      rafRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [transform, width, height, backgroundColor, showGrid, gridSize, gridColor, onRender]);

  // Handle mouse events with world coordinate conversion
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      handlers.onMouseMove(e);

      if (onWorldMouseMove && !isPanning) {
        const rect = e.currentTarget.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const world = screenToWorld(screenX, screenY);
        onWorldMouseMove(world.x, world.y, screenX, screenY);
      }
    },
    [handlers, isPanning, screenToWorld, onWorldMouseMove]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (onWorldClick && !isPanning) {
        const rect = e.currentTarget.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const world = screenToWorld(screenX, screenY);
        onWorldClick(world.x, world.y, e.button);
      }
    },
    [isPanning, screenToWorld, onWorldClick]
  );

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        cursor: isPanning ? 'grabbing' : 'crosshair',
        ...style,
      }}
      onWheel={handlers.onWheel}
      onMouseDown={handlers.onMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handlers.onMouseUp}
      onMouseLeave={handlers.onMouseLeave}
      onClick={handleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />
      {/* Children are rendered in a transformed div overlay */}
      {children && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
            transformOrigin: '0 0',
            pointerEvents: 'none',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default PanZoomCanvas;
