import type { Tool } from '../App';
import type { TileDefinition } from '../lib/manifest';

interface ToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  activeAssetId: number;
  onAssetChange: (id: number) => void;
  tiles: TileDefinition[];
}

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'pan', label: 'Pan', key: 'H' },
  { id: 'draw', label: 'Draw', key: 'B' },
  { id: 'erase', label: 'Erase', key: 'E' },
  { id: 'fill', label: 'Fill', key: 'G' },
];

export function Toolbar({ tool, onToolChange, activeAssetId, onAssetChange, tiles }: ToolbarProps) {
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

      <span style={{ marginLeft: 16, color: '#556677' }}>|</span>

      <label style={{ marginLeft: 8, color: '#8899aa', fontSize: 12 }}>
        Tile:
        <select
          value={activeAssetId}
          onChange={e => onAssetChange(parseInt(e.target.value))}
          style={{
            marginLeft: 4,
            padding: '2px 4px',
            background: '#0a0a1a',
            color: '#e0e0e0',
            border: '1px solid #0f3460',
            borderRadius: 3,
            fontSize: 12,
            maxWidth: 180,
          }}
        >
          {tiles.length === 0 && <option value={0}>Loading...</option>}
          {tiles.map((t, i) => (
            <option key={t.id} value={i}>
              {t.id} ({t.variations}v)
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
