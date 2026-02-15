import type { Tool } from './types';

export interface ToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
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
  onDelete?: () => void;
}

const TOOLS: { id: Tool; label: string; icon: string; shortcut: string }[] = [
  { id: 'pencil', label: 'Pencil', icon: 'P', shortcut: 'P' },
  { id: 'eraser', label: 'Eraser', icon: 'E', shortcut: 'E' },
  { id: 'fill', label: 'Fill', icon: 'F', shortcut: 'G' },
  { id: 'line', label: 'Line', icon: 'L', shortcut: 'L' },
  { id: 'select', label: 'Select', icon: 'S', shortcut: 'M' },
  { id: 'eyedropper', label: 'Eyedropper', icon: 'I', shortcut: 'I' },
];

const ZOOM_LEVELS = [1, 2, 4, 8, 16, 24, 32];

/** Drawing toolbar with tools, zoom, and transform actions */
export function Toolbar({
  tool,
  onToolChange,
  zoom,
  onZoomChange,
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
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => onToolChange(t.id)}
            title={`${t.label} (${t.shortcut})`}
            style={{
              width: 32,
              height: 32,
              border: 'none',
              borderRadius: '4px',
              background: tool === t.id ? '#4ecca3' : '#0f0f23',
              color: tool === t.id ? '#1a1a2e' : '#ccc',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '0.875rem',
            }}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <div style={{ width: 1, height: 24, background: '#333' }} />

      {/* Undo/Redo */}
      <div style={{ display: 'flex', gap: '2px' }}>
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: canUndo ? '#ccc' : '#555',
            cursor: canUndo ? 'pointer' : 'not-allowed',
            fontSize: '1rem',
          }}
        >
          ↶
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: canRedo ? '#ccc' : '#555',
            cursor: canRedo ? 'pointer' : 'not-allowed',
            fontSize: '1rem',
          }}
        >
          ↷
        </button>
      </div>

      <div style={{ width: 1, height: 24, background: '#333' }} />

      {/* Transform */}
      <div style={{ display: 'flex', gap: '2px' }}>
        <button
          onClick={onRotateCCW}
          title="Rotate Counter-clockwise"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          ⟲
        </button>
        <button
          onClick={onRotateCW}
          title="Rotate Clockwise"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          ⟳
        </button>
        <button
          onClick={onFlipH}
          title="Flip Horizontal"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          ⇆
        </button>
        <button
          onClick={onFlipV}
          title="Flip Vertical"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          ⇅
        </button>
      </div>

      <div style={{ width: 1, height: 24, background: '#333' }} />

      {/* Clipboard */}
      <div style={{ display: 'flex', gap: '2px' }}>
        <button
          onClick={onCopy}
          title="Copy Selection (Ctrl+C)"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '0.75rem',
          }}
        >
          ⎘
        </button>
        <button
          onClick={onPaste}
          title="Paste (Ctrl+V)"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '0.75rem',
          }}
        >
          ⎗
        </button>
        <button
          onClick={onDelete}
          title="Delete Selection (Del)"
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '4px',
            background: '#0f0f23',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: '0.75rem',
          }}
        >
          ✕
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
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={showGrid}
          onChange={(e) => onShowGridChange(e.target.checked)}
        />
        <span style={{ color: '#888', fontSize: '0.75rem' }}>Grid</span>
      </label>

      {/* Zoom */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        <span style={{ color: '#888', fontSize: '0.75rem' }}>Zoom:</span>
        <select
          value={zoom}
          onChange={(e) => onZoomChange(parseInt(e.target.value, 10))}
          style={{
            background: '#0f0f23',
            border: '1px solid #333',
            borderRadius: '4px',
            padding: '0.25rem',
            color: '#ccc',
            fontSize: '0.75rem',
          }}
        >
          {ZOOM_LEVELS.map((z) => (
            <option key={z} value={z}>
              {z}x
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default Toolbar;
