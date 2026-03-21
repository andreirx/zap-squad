import { useState, useCallback, useEffect } from 'react';
import { InfiniteCanvas } from './components/InfiniteCanvas';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { AssetPanel } from './components/AssetPanel';
import {
  loadTileManifest,
  TileDefinition,
  TileRegistryEntry,
  CharacterDefinition,
  WeaponDefinition,
} from './lib/manifest';

export type Tool = 'pan' | 'draw' | 'erase' | 'fill' | 'line' | 'rect' | 'character';

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

  // Manifest data — loaded once at startup
  const [tiles, setTiles] = useState<TileDefinition[]>([]);
  const [tileRegistry, setTileRegistry] = useState<TileRegistryEntry[]>([]);
  const [characters, setCharacters] = useState<CharacterDefinition[]>([]);
  const [weapons, setWeapons] = useState<WeaponDefinition[]>([]);

  // ── Tool hotkeys (global) ────────────────────────────────────────
  // Matches the key labels shown in Toolbar button tooltips.
  // Guarded against modifier keys (Ctrl/Meta/Alt bypass) and form focus.
  useEffect(() => {
    const HOTKEYS: Record<string, Tool> = {
      h: 'pan',
      b: 'draw',
      e: 'erase',
      g: 'fill',
      l: 'line',
      r: 'rect',
      c: 'character',
    };
    const handler = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mapped = HOTKEYS[ev.key.toLowerCase()];
      if (mapped) {
        ev.preventDefault();
        setTool(mapped);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    loadTileManifest()
      .then(({ tiles, registry, characters, weapons }) => {
        setTiles(tiles);
        setTileRegistry(registry);
        setCharacters(characters);
        setWeapons(weapons);
        console.log(`[freedom-board] loaded ${tiles.length} tiles, ${characters.length} characters, ${weapons.length} weapons`);
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
      <Toolbar tool={tool} onToolChange={setTool} />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <AssetPanel
          tiles={tiles}
          characters={characters}
          weapons={weapons}
          activeAssetId={activeAssetId}
          onAssetChange={setActiveAssetId}
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
      </div>
      <StatusBar
        cursorTile={cursorTile}
        camera={cameraState}
        worldStats={worldStats}
      />
    </div>
  );
}
