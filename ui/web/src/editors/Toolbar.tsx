import {
  Pencil,
  Eraser,
  PaintBucket,
  Minus,
  SquareDashed,
  Pipette,
  Undo2,
  Redo2,
  RotateCcw,
  RotateCw,
  FlipHorizontal2,
  FlipVertical2,
  Copy,
  Clipboard,
  Scissors,
  Trash2,
  Grid3X3,
  ZoomIn,
  ZoomOut,
  Circle,
} from 'lucide-react';
import type { Tool } from './types';

export interface ToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  brushSize?: number;
  onBrushSizeChange?: (size: number) => void;
  showGrid: boolean;
  onShowGridChange: (show: boolean) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onClear?: () => void;
  onRotateCW?: () => void;
  onRotateCCW?: () => void;
  onFlipH?: () => void;
  onFlipV?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onCut?: () => void;
  onDelete?: () => void;
}

const TOOLS: { id: Tool; label: string; icon: typeof Pencil; shortcut: string }[] = [
  { id: 'pencil', label: 'Pencil', icon: Pencil, shortcut: 'P' },
  { id: 'eraser', label: 'Eraser', icon: Eraser, shortcut: 'E' },
  { id: 'fill', label: 'Fill', icon: PaintBucket, shortcut: 'G' },
  { id: 'line', label: 'Line', icon: Minus, shortcut: 'L' },
  { id: 'select', label: 'Select', icon: SquareDashed, shortcut: 'M' },
  { id: 'eyedropper', label: 'Eyedropper', icon: Pipette, shortcut: 'I' },
];

const ZOOM_LEVELS = [1, 2, 4, 8, 16, 24, 32];
const BRUSH_SIZES = [1, 2, 4, 8, 16];

const iconSize = 16;

const btnStyle = (active = false, disabled = false): React.CSSProperties => ({
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: '4px',
  background: active ? '#4ecca3' : '#0f0f23',
  color: disabled ? '#555' : active ? '#1a1a2e' : '#ccc',
  cursor: disabled ? 'not-allowed' : 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

/** Drawing toolbar with tools, zoom, and transform actions */
export function Toolbar({
  tool,
  onToolChange,
  zoom,
  onZoomChange,
  brushSize = 1,
  onBrushSizeChange,
  showGrid,
  onShowGridChange,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  onClear,
  onRotateCW,
  onRotateCCW,
  onFlipH,
  onFlipV,
  onCopy,
  onPaste,
  onCut,
  onDelete,
}: ToolbarProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        padding: '0.5rem',
        background: '#16213e',
        borderRadius: '4px',
        alignItems: 'center',
      }}
    >
      {/* Tools */}
      <div style={{ display: 'flex', gap: '2px' }}>
        {TOOLS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => onToolChange(t.id)}
              title={`${t.label} (${t.shortcut})`}
              style={btnStyle(tool === t.id)}
            >
              <Icon size={iconSize} />
            </button>
          );
        })}
      </div>

      <div style={{ width: 1, height: 24, background: '#333' }} />

      {/* Brush Size */}
      {onBrushSizeChange && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
            <Circle size={12} style={{ color: '#888', marginRight: 4 }} />
            {BRUSH_SIZES.map((size) => (
              <button
                key={size}
                onClick={() => onBrushSizeChange(size)}
                title={`Brush Size ${size}px`}
                style={{
                  ...btnStyle(brushSize === size),
                  width: 28,
                  height: 28,
                  fontSize: '0.7rem',
                }}
              >
                {size}
              </button>
            ))}
          </div>
          <div style={{ width: 1, height: 24, background: '#333' }} />
        </>
      )}

      {/* Undo/Redo */}
      <div style={{ display: 'flex', gap: '2px' }}>
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          style={btnStyle(false, !canUndo)}
        >
          <Undo2 size={iconSize} />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          style={btnStyle(false, !canRedo)}
        >
          <Redo2 size={iconSize} />
        </button>
      </div>

      <div style={{ width: 1, height: 24, background: '#333' }} />

      {/* Transform */}
      <div style={{ display: 'flex', gap: '2px' }}>
        <button
          onClick={onRotateCCW}
          title="Rotate Counter-clockwise"
          style={btnStyle()}
        >
          <RotateCcw size={iconSize} />
        </button>
        <button
          onClick={onRotateCW}
          title="Rotate Clockwise"
          style={btnStyle()}
        >
          <RotateCw size={iconSize} />
        </button>
        <button
          onClick={onFlipH}
          title="Flip Horizontal"
          style={btnStyle()}
        >
          <FlipHorizontal2 size={iconSize} />
        </button>
        <button
          onClick={onFlipV}
          title="Flip Vertical"
          style={btnStyle()}
        >
          <FlipVertical2 size={iconSize} />
        </button>
      </div>

      <div style={{ width: 1, height: 24, background: '#333' }} />

      {/* Clipboard */}
      <div style={{ display: 'flex', gap: '2px' }}>
        <button
          onClick={onCut}
          title="Cut (Ctrl+X)"
          style={btnStyle()}
        >
          <Scissors size={iconSize} />
        </button>
        <button
          onClick={onCopy}
          title="Copy (Ctrl+C)"
          style={btnStyle()}
        >
          <Copy size={iconSize} />
        </button>
        <button
          onClick={onPaste}
          title="Paste (Ctrl+V)"
          style={btnStyle()}
        >
          <Clipboard size={iconSize} />
        </button>
        <button
          onClick={onDelete}
          title="Delete (Del)"
          style={btnStyle()}
        >
          <Trash2 size={iconSize} />
        </button>
      </div>

      <div style={{ width: 1, height: 24, background: '#333' }} />

      {/* Clear */}
      <button
        onClick={onClear}
        title="Clear Canvas"
        style={{
          padding: '0.25rem 0.5rem',
          border: 'none',
          borderRadius: '4px',
          background: '#ff6b6b',
          color: '#fff',
          cursor: 'pointer',
          fontSize: '0.75rem',
        }}
      >
        Clear
      </button>

      <div style={{ flex: 1 }} />

      {/* Grid toggle */}
      <button
        onClick={() => onShowGridChange(!showGrid)}
        title="Toggle Grid"
        style={btnStyle(showGrid)}
      >
        <Grid3X3 size={iconSize} />
      </button>

      {/* Zoom controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        <button
          onClick={() => {
            const idx = ZOOM_LEVELS.indexOf(zoom);
            if (idx > 0) onZoomChange(ZOOM_LEVELS[idx - 1]);
          }}
          disabled={zoom === ZOOM_LEVELS[0]}
          title="Zoom Out"
          style={btnStyle(false, zoom === ZOOM_LEVELS[0])}
        >
          <ZoomOut size={iconSize} />
        </button>
        <span style={{ color: '#888', fontSize: '0.75rem', minWidth: 32, textAlign: 'center' }}>
          {zoom}x
        </span>
        <button
          onClick={() => {
            const idx = ZOOM_LEVELS.indexOf(zoom);
            if (idx < ZOOM_LEVELS.length - 1) onZoomChange(ZOOM_LEVELS[idx + 1]);
          }}
          disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
          title="Zoom In"
          style={btnStyle(false, zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1])}
        >
          <ZoomIn size={iconSize} />
        </button>
      </div>
    </div>
  );
}

export default Toolbar;
