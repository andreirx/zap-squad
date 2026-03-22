import { useState, useCallback, useEffect, useRef } from 'react';
import { InfiniteCanvas, tileTypeToLayer } from './components/InfiniteCanvas';
import { FBToolbar } from './components/FBToolbar';
import { StatusBar } from './components/StatusBar';
import { AssetPanel } from './components/AssetPanel';
import { WorldListModal } from './components/WorldListModal';
import {
  loadTileManifest,
  TileDefinition,
  TileRegistryEntry,
  CharacterDefinition,
  WeaponDefinition,
} from './lib/manifest';
import type { Tool, WorldStats } from './types';
import { worldStore } from '../lib/idb';
import type { WorldData } from '../lib/idb';

// ── LDtk grid tile (matches MapEditor output) ────────────────────────
interface LdtkGridTile {
  px: [number, number];
  t: number | null;
  src: string;
}

interface LdtkLayerInstance {
  __identifier: string;
  __type: string;
  __gridSize: number;
  gridTiles?: LdtkGridTile[];
}

interface LdtkLevel {
  levels: Array<{
    identifier: string;
    pxWid: number;
    pxHei: number;
    layerInstances: LdtkLayerInstance[];
  }>;
}

/**
 * Parse an LDtk level JSON file and resolve all tile references to a stamp payload.
 *
 * Resolution steps:
 * 1. Flatten all Tiles layerInstances' gridTiles into one list
 * 2. For each gridTile: look up `src` (tile name) in tileRegistry to get asset_id (index)
 * 3. Derive storage layer from tileType/terrainType via tileTypeToLayer()
 * 4. Compute variant: for TILE type = (seed % variations), for PATH/BRIDGE = 0
 *    (renderer recomputes PATH connectivity at render time via connectivity_bitmask)
 * 5. Convert px coords to tile coords (divide by __gridSize)
 *
 * Returns JSON string ready for WASM load_level(), or null on parse failure.
 */
function parseLdtkToStamp(
  fileContent: string,
  registry: TileRegistryEntry[],
  originX: number,
  originY: number,
): string | null {
  let ldtk: LdtkLevel;
  try {
    ldtk = JSON.parse(fileContent);
  } catch {
    console.error('[freedom-board] failed to parse LDtk JSON');
    return null;
  }

  if (!ldtk.levels || ldtk.levels.length === 0) {
    console.error('[freedom-board] LDtk file has no levels');
    return null;
  }

  // Build name → index lookup (same ordering as tileRegistry)
  const nameToIndex = new Map<string, number>();
  registry.forEach((entry, idx) => {
    nameToIndex.set(entry.name, idx);
  });

  const level = ldtk.levels[0];
  const tiles: Array<{ x: number; y: number; assetId: number; layer: number; variant: number }> = [];
  let skipped = 0;

  for (const layerInst of level.layerInstances) {
    if (layerInst.__type !== 'Tiles' || !layerInst.gridTiles) continue;

    const gridSize = layerInst.__gridSize || 128;

    for (const gt of layerInst.gridTiles) {
      const assetId = nameToIndex.get(gt.src);
      if (assetId === undefined) {
        skipped++;
        continue;
      }

      const entry = registry[assetId];
      const layer = tileTypeToLayer(entry);

      // Variant: for terrain TILE, use seed mod variations. For PATH/BRIDGE, 0 (renderer recomputes).
      let variant = 0;
      if (entry.tileType === 'TILE' && gt.t != null && entry.variations > 1) {
        variant = Math.abs(gt.t) % entry.variations;
      }

      const tileX = Math.floor(gt.px[0] / gridSize);
      const tileY = Math.floor(gt.px[1] / gridSize);

      tiles.push({ x: tileX, y: tileY, assetId, layer, variant });
    }
  }

  if (skipped > 0) {
    console.warn(`[freedom-board] stamp: skipped ${skipped} tiles with unknown asset names`);
  }

  console.log(`[freedom-board] parsed LDtk level "${level.identifier}": ${tiles.length} tiles`);

  return JSON.stringify({ originX, originY, tiles });
}

/**
 * Trigger a browser file download with the given content.
 */
function downloadFile(filename: string, content: string, mimeType = 'application/json') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function FreedomBoardPage() {
  const [tool, setTool] = useState<Tool>('draw');
  const [activeAssetId, setActiveAssetId] = useState(0);
  const [activeCharacterId, setActiveCharacterId] = useState(0);
  const [worldStats, setWorldStats] = useState<WorldStats>({ tileCount: 0, chunkCount: 0 });
  const [cursorTile, setCursorTile] = useState<{ x: number; y: number } | null>(null);
  const [cameraState, setCameraState] = useState({ x: 0, y: 0, zoom: 64 });

  // Manifest data — loaded once at startup
  const [tiles, setTiles] = useState<TileDefinition[]>([]);
  const [tileRegistry, setTileRegistry] = useState<TileRegistryEntry[]>([]);
  const [characters, setCharacters] = useState<CharacterDefinition[]>([]);
  const [weapons, setWeapons] = useState<WeaponDefinition[]>([]);

  // Stamp state — set when user imports a map file, cleared after dispatch to WASM
  const [pendingStamp, setPendingStamp] = useState<string | null>(null);
  // World import state — set when user loads a world file from disk
  const [pendingWorldImport, setPendingWorldImport] = useState<string | null>(null);
  const [showWorldList, setShowWorldList] = useState(false);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const worldFileInputRef = useRef<HTMLInputElement>(null);

  // Last exported world data (for save-to-disk)
  const lastExportRef = useRef<WorldData | null>(null);

  // ── Tool hotkeys (global) ────────────────────────────────────────
  // Matches the key labels shown in FBToolbar button tooltips.
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

  // ── Map import handler ─────────────────────────────────────────────
  // Reads the selected LDtk JSON file, resolves tiles, stamps at viewport center.
  const handleImportFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      // Stamp origin = current viewport top-left (integer tile coords)
      const originX = Math.floor(cameraState.x);
      const originY = Math.floor(cameraState.y);
      const json = parseLdtkToStamp(text, tileRegistry, originX, originY);
      if (json) {
        setPendingStamp(json);
      }
    };
    reader.readAsText(file);
  }, [cameraState, tileRegistry]);

  const handleImportClick = useCallback(() => {
    mapFileInputRef.current?.click();
  }, []);

  const handleMapFileChange = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (file) {
      handleImportFile(file);
    }
    // Reset so the same file can be re-imported
    ev.target.value = '';
  }, [handleImportFile]);

  const handleStampComplete = useCallback(() => {
    setPendingStamp(null);
  }, []);

  // ── Save to disk (download world JSON) ─────────────────────────────
  const handleWorldExport = useCallback((worldData: WorldData) => {
    lastExportRef.current = worldData;
  }, []);

  const handleSaveToDisk = useCallback(() => {
    const data = lastExportRef.current;
    if (!data) {
      console.warn('[freedom-board] no world data to save — draw some tiles first');
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `freedom-board-${timestamp}.json`;
    downloadFile(filename, JSON.stringify(data, null, 2));
    console.log(`[freedom-board] saved world to ${filename}`);
  }, []);

  // ── Load from disk (upload world JSON → import to WASM) ────────────
  const handleLoadFromDisk = useCallback(() => {
    worldFileInputRef.current?.click();
  }, []);

  const handleWorldFileChange = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const data = JSON.parse(text) as WorldData;
        if (!data.version || !data.tiles) {
          console.error('[freedom-board] invalid world file: missing version or tiles');
          return;
        }
        // Send directly to WASM via import_world (no page reload needed).
        // Also save to IDB so it persists across sessions.
        setPendingWorldImport(JSON.stringify(data));
        worldStore.save('autosave', data).catch(err =>
          console.warn('[freedom-board] failed to save imported world to IDB:', err)
        );
        console.log(`[freedom-board] loaded from disk: ${data.tiles.length} tiles, ${data.characters.length} characters`);
      } catch (err) {
        console.error('[freedom-board] failed to parse world file:', err);
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  }, []);

  // ── World list handlers ─────────────────────────────────────────────
  const handleWorldListLoad = useCallback((name: string) => {
    worldStore.load(name).then(data => {
      if (data) {
        setPendingWorldImport(JSON.stringify(data));
        console.log(`[freedom-board] loading world "${name}": ${data.tiles.length} tiles`);
      }
    });
  }, []);

  const handleWorldListSaveAs = useCallback((name: string) => {
    const data = lastExportRef.current;
    if (!data) {
      console.warn('[freedom-board] no world data to save — draw some tiles first');
      return;
    }
    worldStore.save(name, data).then(() => {
      console.log(`[freedom-board] saved world as "${name}"`);
    });
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Hidden file inputs for map import and world load */}
      <input
        ref={mapFileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleMapFileChange}
      />
      <input
        ref={worldFileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleWorldFileChange}
      />
      <FBToolbar
        tool={tool}
        onToolChange={setTool}
        onImport={handleImportClick}
        onSaveToDisk={handleSaveToDisk}
        onLoadFromDisk={handleLoadFromDisk}
        onWorldList={useCallback(() => setShowWorldList(true), [])}
      />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <AssetPanel
          tiles={tiles}
          characters={characters}
          weapons={weapons}
          activeAssetId={activeAssetId}
          onAssetChange={setActiveAssetId}
          activeCharacterId={activeCharacterId}
          onCharacterChange={setActiveCharacterId}
        />
        <div style={{ flex: 1, position: 'relative' }}>
          <InfiniteCanvas
            tool={tool}
            activeAssetId={activeAssetId}
            activeCharacterId={activeCharacterId}
            tileRegistry={tileRegistry}
            characterNames={characters.map(c => c.id)}
            pendingStamp={pendingStamp}
            onStampComplete={handleStampComplete}
            pendingWorldImport={pendingWorldImport}
            onWorldImportComplete={useCallback(() => setPendingWorldImport(null), [])}
            onCursorTileChange={setCursorTile}
            onCameraChange={setCameraState}
            onGameEvent={handleGameEvent}
            onWorldExport={handleWorldExport}
          />
        </div>
      </div>
      <StatusBar
        cursorTile={cursorTile}
        camera={cameraState}
        worldStats={worldStats}
      />
      {showWorldList && (
        <WorldListModal
          onClose={useCallback(() => setShowWorldList(false), [])}
          onLoad={handleWorldListLoad}
          onSaveAs={handleWorldListSaveAs}
        />
      )}
    </div>
  );
}

export default FreedomBoardPage;
