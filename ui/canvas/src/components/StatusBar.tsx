import type { WorldStats } from '../App';

interface StatusBarProps {
  cursorTile: { x: number; y: number } | null;
  camera: { x: number; y: number; zoom: number };
  worldStats: WorldStats;
}

export function StatusBar({ cursorTile, camera, worldStats }: StatusBarProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      padding: '4px 12px',
      background: '#16213e',
      borderTop: '1px solid #0f3460',
      fontSize: 11,
      color: '#8899aa',
      fontFamily: 'monospace',
      userSelect: 'none',
    }}>
      <span>
        Cursor: {cursorTile ? `(${cursorTile.x}, ${cursorTile.y})` : '—'}
      </span>
      <span>
        Camera: ({camera.x.toFixed(1)}, {camera.y.toFixed(1)}) zoom: {camera.zoom.toFixed(0)}px/tile
      </span>
      <span>
        Tiles: {worldStats.tileCount} | Chunks: {worldStats.chunkCount}
      </span>
    </div>
  );
}
