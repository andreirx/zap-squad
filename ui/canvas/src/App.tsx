import { useState, useCallback, useEffect } from 'react';
import { InfiniteCanvas } from './components/InfiniteCanvas';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { loadTileManifest, TileDefinition, TileRegistryEntry } from './lib/manifest';

export type Tool = 'pan' | 'draw' | 'erase' | 'fill';

export interface WorldStats {
  tileCount: number;
  chunkCount: number;
}

export default function App() {
  const [tool, setTool] = useState<Tool>('draw');
  const [activeAssetId, setActiveAssetId] = useState(0);
  const [worldStats, setWorldStats] = useState<WorldStats>({ tileCount: 0, chunkCount: 0 });
  const [cursorTile, setCursorTile] = useState<{ x: number; y: number } | null>(null);
  const [cameraState, setCameraState] = useState({ x: 0, y: 0, zoom: 64 });

  // Tile manifest data — loaded once at startup
  const [tiles, setTiles] = useState<TileDefinition[]>([]);
  const [tileRegistry, setTileRegistry] = useState<TileRegistryEntry[]>([]);

  useEffect(() => {
    loadTileManifest()
      .then(({ tiles, registry }) => {
        setTiles(tiles);
        setTileRegistry(registry);
        console.log(`[freedom-board] loaded ${tiles.length} tile definitions`);
      })
      .catch(err => {
        console.error('[freedom-board] failed to load manifest:', err);
      });
  }, []);

  const handleGameEvent = useCallback((events: Array<{ kind: number; a: number; b: number; c: number }>) => {
    for (const e of events) {
      if (e.kind === 1) {
        setWorldStats({ tileCount: e.a, chunkCount: e.b });
      }
    }
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        activeAssetId={activeAssetId}
        onAssetChange={setActiveAssetId}
        tiles={tiles}
      />
      <div style={{ flex: 1, position: 'relative' }}>
        <InfiniteCanvas
          tool={tool}
          activeAssetId={activeAssetId}
          tileRegistry={tileRegistry}
          onCursorTileChange={setCursorTile}
          onCameraChange={setCameraState}
          onGameEvent={handleGameEvent}
        />
      </div>
      <StatusBar
        cursorTile={cursorTile}
        camera={cameraState}
        worldStats={worldStats}
      />
    </div>
  );
}
