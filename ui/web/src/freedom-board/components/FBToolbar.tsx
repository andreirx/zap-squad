import type { Tool } from '../types';

interface FBToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  onImport: () => void;
  onSaveToDisk: () => void;
  onLoadFromDisk: () => void;
  onWorldList: () => void;
}

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'pan', label: 'Pan', key: 'H' },
  { id: 'draw', label: 'Draw', key: 'B' },
  { id: 'erase', label: 'Erase', key: 'E' },
  { id: 'fill', label: 'Fill', key: 'G' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'rect', label: 'Rect', key: 'R' },
  { id: 'character', label: 'Char', key: 'C' },
];

export function FBToolbar({ tool, onToolChange, onImport, onSaveToDisk, onLoadFromDisk, onWorldList }: FBToolbarProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      background: '#16213e',
      borderBottom: '1px solid #0f3460',
      fontSize: 13,
      userSelect: 'none',
    }}>
      {TOOLS.map(t => (
        <button
          key={t.id}
          onClick={() => onToolChange(t.id)}
          style={{
            padding: '4px 10px',
            background: tool === t.id ? '#0f3460' : 'transparent',
            color: tool === t.id ? '#e94560' : '#8899aa',
            border: tool === t.id ? '1px solid #e94560' : '1px solid transparent',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
          title={`${t.label} (${t.key})`}
        >
          {t.label}
        </button>
      ))}

      {/* Separator */}
      <div style={{ width: 1, height: 20, background: '#0f3460', marginLeft: 4, marginRight: 4 }} />

      <button
        onClick={onImport}
        style={{
          padding: '4px 10px',
          background: '#1a2a4a',
          color: '#60a0e0',
          border: '1px solid #2a4a6a',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
        }}
        title="Import LDtk map file (stamps at viewport position)"
      >
        Import Map
      </button>

      {/* Separator */}
      <div style={{ width: 1, height: 20, background: '#0f3460', marginLeft: 4, marginRight: 4 }} />

      <button
        onClick={onSaveToDisk}
        style={{
          padding: '4px 10px',
          background: '#1a2a4a',
          color: '#8ac060',
          border: '1px solid #3a5a2a',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
        }}
        title="Download world as JSON file"
      >
        Save
      </button>

      <button
        onClick={onLoadFromDisk}
        style={{
          padding: '4px 10px',
          background: '#1a2a4a',
          color: '#e0a060',
          border: '1px solid #5a4a2a',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
        }}
        title="Load world from JSON file (replaces current)"
      >
        Load
      </button>

      <button
        onClick={onWorldList}
        style={{
          padding: '4px 10px',
          background: '#1a2a4a',
          color: '#a080e0',
          border: '1px solid #4a3a6a',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
        }}
        title="Manage saved worlds (list, rename, delete)"
      >
        Worlds
      </button>

      <span style={{ marginLeft: 'auto', color: '#445566', fontSize: 10 }}>
        Ctrl+Z undo | Ctrl+Shift+Z redo
      </span>
    </div>
  );
}
