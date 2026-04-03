import { useState, useCallback, useEffect, useRef } from 'react';
import { InfiniteCanvas, tileTypeToLayer } from './components/InfiniteCanvas';
import { FBToolbar } from './components/FBToolbar';
import { StatusBar } from './components/StatusBar';
import { AssetPanel } from './components/AssetPanel';
import { ScriptPanel } from './components/ScriptPanel';
import { CharacterPanel } from './components/CharacterPanel';
import { WorldListModal } from './components/WorldListModal';
import { GameHUD } from './components/GameHUD';
import {
  loadFreedomBoardAssets,
  TileDefinition,
  TileRegistryEntry,
  CharacterDefinition,
  WeaponDefinition,
} from './lib/manifest';
import type { Tool, WorldStats, PendingPlacement, StampTile } from './types';
import { worldStore, gameDefStore } from '../lib/idb';
import type { WorldData } from '../lib/idb';
import { onCharacterAssetsChanged } from '../lib/asset-events';

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
/**
 * Parse an LDtk JSON file into a PendingPlacement (tiles with relative coords + dimensions).
 * Does NOT bake an origin — the user picks the placement position interactively.
 */
function parseLdtkFile(
  fileContent: string,
  registry: TileRegistryEntry[],
): PendingPlacement | null {
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
  const tiles: StampTile[] = [];
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

  // Compute map dimensions from tile extents
  let maxX = 0, maxY = 0;
  for (const t of tiles) {
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
  }

  const result: PendingPlacement = {
    tiles,
    widthTiles: maxX + 1,
    heightTiles: maxY + 1,
    levelName: level.identifier,
  };

  console.log(`[freedom-board] parsed LDtk level "${level.identifier}": ${tiles.length} tiles, ${result.widthTiles}x${result.heightTiles}`);
  return result;
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
  const charactersRef = useRef<CharacterDefinition[]>([]);
  const activeCharacterIdRef = useRef(0);

  // Stamp state — set when user imports a map file, cleared after dispatch to WASM
  const [pendingStamp, setPendingStamp] = useState<string | null>(null);
  // Placement mode — parsed map waiting for user to pick a position
  const [pendingPlacement, setPendingPlacement] = useState<PendingPlacement | null>(null);
  // World import state — set when user loads a world file from disk
  const [pendingWorldImport, setPendingWorldImport] = useState<string | null>(null);
  const [showWorldList, setShowWorldList] = useState(false);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const worldFileInputRef = useRef<HTMLInputElement>(null);

  // Last exported world data (for save-to-disk)
  const lastExportRef = useRef<WorldData | null>(null);

  // ── Game session state ──────────────────────────────────────────────
  // State is driven by WASM acknowledgment events (SESSION_STATE kind=2),
  // not by optimistic local toggling. This prevents UI/runtime drift when
  // validation rejects a start or WASM fails to parse a definition.
  const [isPlaying, setIsPlaying] = useState(false);
  const [savedGameDefs, setSavedGameDefs] = useState<string[]>([]);
  const [selectedGameDef, setSelectedGameDef] = useState<string | null>(null);
  const [gameDefLoaded, setGameDefLoaded] = useState(false);
  const sendEventRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);

  // ── HUD boundary state ────────────────────────────────────────────
  // Received from WASM via take_game_hud_state() (change-gated, not per-frame).
  const [hudState, setHudState] = useState<Record<string, unknown> | null>(null);
  // One-shot start-failure diagnostics from take_start_errors().
  const [startErrors, setStartErrors] = useState<Array<Record<string, unknown>> | null>(null);
  // One-shot per-script compile results from take_compile_results().
  // Wired to ScriptPanel for per-script status display.
  const [_compileResults, setCompileResults] = useState<Array<Record<string, unknown>> | null>(null);

  // ── Script panel state ────────────────────────────────────────────
  const [showScripts, setShowScripts] = useState(false);

  const handleReloadScripts = useCallback((scriptsJson: string) => {
    sendEventRef.current?.({ type: 'reload_scripts', json: scriptsJson });
  }, []);

  // ── Selected character state ──────────────────────────────────────
  const [selectedCharacterJson, setSelectedCharacterJson] = useState<string | null>(null);

  const handleSelectedCharacter = useCallback((json: string | null) => {
    setSelectedCharacterJson(json);
  }, []);

  const handleSendCharacterEvent = useCallback((msg: Record<string, unknown>) => {
    sendEventRef.current?.(msg);
  }, []);

  // Load saved game definitions list
  useEffect(() => {
    gameDefStore.list().then(names => {
      setSavedGameDefs(names);
      if (names.length > 0 && !selectedGameDef) {
        setSelectedGameDef(names[0]);
      }
    }).catch(err => {
      console.error('[freedom-board] failed to load game definitions:', err);
    });
  }, []);

  // Load the selected game definition into WASM when it changes
  useEffect(() => {
    if (!selectedGameDef || !sendEventRef.current) return;
    setGameDefLoaded(false); // reset until WASM confirms
    gameDefStore.load(selectedGameDef).then(record => {
      if (!record) return;
      const json = JSON.stringify(record.definition);
      sendEventRef.current?.({ type: 'load_game_definition', json });
      console.log(`[freedom-board] sent game definition to WASM: "${selectedGameDef}"`);
    });
  }, [selectedGameDef]);

  const handlePlay = useCallback(() => {
    if (!gameDefLoaded) return;
    setStartErrors(null); // Clear stale errors from previous attempt
    sendEventRef.current?.({ type: 'start_game' });
    // Do NOT set isPlaying here — wait for WASM SESSION_STATE acknowledgment
  }, [gameDefLoaded]);

  const handleStop = useCallback(() => {
    sendEventRef.current?.({ type: 'stop_game' });
    // Do NOT set isPlaying or hudState here — wait for WASM SESSION_STATE
    // and hud_state acknowledgments. See comment at line 182.
  }, []);

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
    charactersRef.current = characters;
  }, [characters]);

  useEffect(() => {
    activeCharacterIdRef.current = activeCharacterId;
  }, [activeCharacterId]);

  const revokeCharacterAtlasUrls = useCallback((defs: CharacterDefinition[]) => {
    for (const def of defs) {
      if (def.atlasUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(def.atlasUrl);
      }
    }
  }, []);

  const reloadAssetCatalog = useCallback(async () => {
    const previousCharacters = charactersRef.current;
    const currentCharacterId =
      previousCharacters[activeCharacterIdRef.current]?.id ?? null;
    const { tiles, registry, characters: nextCharacters, weapons } = await loadFreedomBoardAssets();

    setTiles(tiles);
    setTileRegistry(registry);
    charactersRef.current = nextCharacters;
    setCharacters(nextCharacters);
    setWeapons(weapons);
    revokeCharacterAtlasUrls(previousCharacters);

    if (currentCharacterId) {
      const nextIndex = nextCharacters.findIndex(c => c.id === currentCharacterId);
      const resolvedIndex = nextIndex >= 0 ? nextIndex : 0;
      activeCharacterIdRef.current = resolvedIndex;
      setActiveCharacterId(resolvedIndex);
    } else if (nextCharacters.length === 0) {
      activeCharacterIdRef.current = 0;
      setActiveCharacterId(0);
    }

    console.log(
      `[freedom-board] loaded ${tiles.length} tiles, ${nextCharacters.length} characters, ${weapons.length} weapons`
    );
  }, [revokeCharacterAtlasUrls]);

  useEffect(() => {
    reloadAssetCatalog().catch(err => {
      console.error('[freedom-board] failed to load asset catalog:', err);
    });

    const off = onCharacterAssetsChanged(({ characterId }) => {
      console.log(`[freedom-board] character assets changed: "${characterId}"`);
      reloadAssetCatalog().catch(err => {
        console.error('[freedom-board] failed to refresh character catalog:', err);
      });
    });

    return () => {
      off();
      revokeCharacterAtlasUrls(charactersRef.current);
    };
  }, [reloadAssetCatalog, revokeCharacterAtlasUrls]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGameEvent = useCallback((events: Array<{ kind: number; a: number; b: number; c: number }>) => {
    for (const e of events) {
      if (e.kind === 1) { // WORLD_STATS
        setWorldStats({ tileCount: e.a, chunkCount: e.b });
      } else if (e.kind === 2) { // SESSION_STATE — authoritative acknowledgment from WASM
        const code = e.a;
        if (code === 1) { // def_loaded
          setGameDefLoaded(true);
        } else if (code === 2) { // playing
          setIsPlaying(true);
        } else if (code === 3) { // stopped
          setIsPlaying(false);
        } else if (code === 4) { // start_failed
          setIsPlaying(false);
          console.warn('[freedom-board] game start failed — check console for validation errors');
        }
      }
    }
  }, []);

  // ── Map import handler ─────────────────────────────────────────────
  // Reads the LDtk JSON file, parses it, and enters placement mode.
  // The user then clicks on the canvas to choose where to place the map.
  const handleImportFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const placement = parseLdtkFile(text, tileRegistry);
      if (placement) {
        setPendingPlacement(placement);
      }
    };
    reader.readAsText(file);
  }, [tileRegistry]);

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

  // Called by InfiniteCanvas when user clicks to deploy the placement
  const handlePlacementDeploy = useCallback((originX: number, originY: number) => {
    if (!pendingPlacement) return;
    const json = JSON.stringify({
      originX,
      originY,
      tiles: pendingPlacement.tiles,
    });
    setPendingStamp(json);
    setPendingPlacement(null);
    console.log(`[freedom-board] deploying "${pendingPlacement.levelName}" at (${originX}, ${originY})`);
  }, [pendingPlacement]);

  const handlePlacementCancel = useCallback(() => {
    setPendingPlacement(null);
    console.log('[freedom-board] placement cancelled');
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
        showScripts={showScripts}
        onToggleScripts={useCallback(() => setShowScripts(v => !v), [])}
        isPlaying={isPlaying}
        hasGameDef={gameDefLoaded}
        onPlay={handlePlay}
        onStop={handleStop}
      />
      {/* Game definition selector — shown above canvas when not playing */}
      {!isPlaying && savedGameDefs.length > 0 && (
        <div style={{
          padding: '4px 12px', background: '#0d1525', borderBottom: '1px solid #1a2a4a',
          display: 'flex', gap: 8, alignItems: 'center', fontSize: 11,
        }}>
          <span style={{ color: '#556677' }}>Game Rules:</span>
          <select
            value={selectedGameDef ?? ''}
            onChange={e => { setSelectedGameDef(e.target.value || null); setGameDefLoaded(false); }}
            style={{
              background: '#0f0f23', border: '1px solid #333', borderRadius: 4,
              padding: '2px 6px', color: '#ccc', fontSize: 11,
            }}
          >
            <option value="">(none)</option>
            {savedGameDefs.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          {gameDefLoaded && <span style={{ color: '#4ecca3', fontSize: 10 }}>loaded</span>}
        </div>
      )}
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
            characterDefs={characters}
            pendingStamp={pendingStamp}
            onStampComplete={handleStampComplete}
            pendingPlacement={pendingPlacement}
            onPlacementDeploy={handlePlacementDeploy}
            onPlacementCancel={handlePlacementCancel}
            pendingWorldImport={pendingWorldImport}
            onWorldImportComplete={useCallback(() => setPendingWorldImport(null), [])}
            onCursorTileChange={setCursorTile}
            onCameraChange={setCameraState}
            onGameEvent={handleGameEvent}
            onWorldExport={handleWorldExport}
            onSendEventReady={useCallback((fn: (msg: Record<string, unknown>) => void) => {
              sendEventRef.current = fn;
            }, [])}
            onSelectedCharacter={handleSelectedCharacter}
            onHudState={useCallback((json: string) => {
              try {
                const parsed = JSON.parse(json);
                setHudState(parsed === null ? null : parsed);
              } catch { /* malformed JSON — ignore */ }
            }, [])}
            onStartErrors={useCallback((json: string) => {
              try { setStartErrors(JSON.parse(json)); } catch { /* ignore */ }
            }, [])}
            onCompileResults={useCallback((json: string) => {
              try { setCompileResults(JSON.parse(json)); } catch { /* ignore */ }
            }, [])}
          />
          <GameHUD
            isPlaying={isPlaying}
            hudState={hudState}
            startErrors={startErrors}
          />
        </div>
        {showScripts && (
          <ScriptPanel
            onReloadScripts={handleReloadScripts}
            disabled={isPlaying}
            compileResults={_compileResults as Array<{ name: string; scope: string; ok: boolean; message: string | null }> | null}
          />
        )}
      </div>
      {selectedCharacterJson && (
        <CharacterPanel
          characterJson={selectedCharacterJson}
          sendEvent={handleSendCharacterEvent}
          disabled={isPlaying}
        />
      )}
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
