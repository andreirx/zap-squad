import type { Tool } from '../App';

interface ToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
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

export function Toolbar({ tool, onToolChange }: ToolbarProps) {
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
      <span style={{ fontWeight: 600, marginRight: 8, color: '#e94560' }}>Freedom Board</span>

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

      <span style={{ marginLeft: 'auto', color: '#445566', fontSize: 10 }}>
        Ctrl+Z undo | Ctrl+Shift+Z redo
      </span>
    </div>
  );
}
