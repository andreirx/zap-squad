import { useState } from 'react';
import { TimingBars } from '@zap/web/react';
import type { PerformanceTiming } from '@zap/web/react';

/**
 * Debug flags controlling WASM-side vector overlays.
 * Sent to WASM as custom event kind=102: a=grid, b=crosshair, c=quadtree.
 */
export interface DebugFlags {
  showGrid: boolean;
  showCrosshair: boolean;
  showQuadtree: boolean;
}

interface DebugPanelProps {
  fps: number;
  timing: PerformanceTiming | null;
  debugFlags: DebugFlags;
  onDebugFlagsChange: (flags: DebugFlags) => void;
  /** Whether SAB lock checking is active (read-only display + toggle). */
  useSabLock: boolean;
  onSabLockChange: (value: boolean) => void;
}

/**
 * Collapsible debug/profiling overlay panel.
 *
 * Contains:
 * - TimingBars (WASM + Draw + Frame breakdown with 120-frame history)
 * - FPS counter
 * - Checkboxes for grid, origin crosshair, quadtree debug rectangles
 *
 * Positioned top-right of the canvas. Collapsed by default — shows only
 * a small FPS indicator. Click to expand the full panel.
 */
export function DebugPanel({
  fps,
  timing,
  debugFlags,
  onDebugFlagsChange,
  useSabLock,
  onSabLockChange,
}: DebugPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const toggle = (key: keyof DebugFlags) => {
    onDebugFlagsChange({ ...debugFlags, [key]: !debugFlags[key] });
  };

  // Stop pointer events from reaching the canvas interaction handler.
  // Without this, the parent div's onPointerDown fires setPointerCapture,
  // which steals focus and prevents the button's click event from firing.
  const stopPropagation = (e: React.PointerEvent) => e.stopPropagation();

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        onPointerDown={stopPropagation}
        style={{
          position: 'absolute',
          top: 4,
          right: 8,
          fontSize: 10,
          color: '#556677',
          fontFamily: 'monospace',
          background: 'rgba(13, 21, 37, 0.6)',
          border: '1px solid #1a2a4a',
          borderRadius: 3,
          padding: '2px 6px',
          cursor: 'pointer',
          zIndex: 10,
        }}
        title="Click to expand debug panel"
      >
        {fps} FPS
      </button>
    );
  }

  return (
    <div
      onPointerDown={stopPropagation}
      style={{
        position: 'absolute',
        top: 4,
        right: 8,
        width: 240,
        background: 'rgba(13, 21, 37, 0.92)',
        border: '1px solid #1a2a4a',
        borderRadius: 4,
        padding: 8,
        fontSize: 10,
        fontFamily: 'monospace',
        color: '#8899aa',
        pointerEvents: 'auto',
        zIndex: 10,
      }}>
      {/* Header with FPS and collapse button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ color: '#c0c8d0', fontWeight: 600 }}>{fps} FPS</span>
        <button
          onClick={() => setExpanded(false)}
          style={{
            background: 'none',
            border: 'none',
            color: '#556677',
            cursor: 'pointer',
            fontSize: 12,
            padding: '0 4px',
          }}
          title="Collapse"
        >
          {'\u2715'}
        </button>
      </div>

      {/* Timing bars */}
      {timing && (
        <div style={{ marginBottom: 8 }}>
          <TimingBars
            timing={timing}
            maxWidth={220}
            barHeight={6}
            showHistory={true}
          />
        </div>
      )}

      {/* Timing numbers */}
      {timing && (
        <div style={{ marginBottom: 8, lineHeight: 1.6 }}>
          <div>WASM: <span style={{ color: '#4CAF50' }}>{(timing.wasmTimeUs / 1000).toFixed(2)}ms</span></div>
          <div>Draw: <span style={{ color: '#2196F3' }}>{(timing.drawTimeUs / 1000).toFixed(2)}ms</span></div>
          <div>Frame: <span style={{ color: '#FF5722' }}>{(timing.frameTimeUs / 1000).toFixed(2)}ms</span></div>
        </div>
      )}

      {/* Separator */}
      <div style={{ height: 1, background: '#1a2a4a', marginBottom: 6 }} />

      {/* Debug overlay toggles */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={debugFlags.showGrid}
            onChange={() => toggle('showGrid')}
            style={{ margin: 0 }}
          />
          Grid lines
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={debugFlags.showCrosshair}
            onChange={() => toggle('showCrosshair')}
            style={{ margin: 0 }}
          />
          Origin crosshair
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={debugFlags.showQuadtree}
            onChange={() => toggle('showQuadtree')}
            style={{ margin: 0 }}
          />
          Quadtree debug
        </label>
      </div>

      {/* Separator */}
      <div style={{ height: 1, background: '#1a2a4a', margin: '6px 0' }} />

      {/* Render settings */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          title="When ON: only reads SharedArrayBuffer after worker signals completion (no tearing). When OFF: reads every frame (may tear, smoother).">
          <input
            type="checkbox"
            checked={useSabLock}
            onChange={() => onSabLockChange(!useSabLock)}
            style={{ margin: 0 }}
          />
          SAB lock
        </label>
      </div>
    </div>
  );
}
