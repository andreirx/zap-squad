import { useState, useCallback, useEffect, useRef } from 'react';
import { Save, Plus, Pencil, Eraser, Move, MousePointer, Users } from 'lucide-react';
import { PanZoomCanvas } from '../../components/PanZoomCanvas';
import { createStorage } from '../../storage';

/** Tile size - everything is 128x128 */
const TILE_SIZE = 128;

/** Map grid tile data (LDtk-compatible) */
interface GridTile {
  px: [number, number];
  t: number | null;  // Variation seed
  src: string;       // Tile asset ID
}

/** Map entity data */
interface EntityInstance {
  __identifier: string;
  px: [number, number];
  defId: string;
  fieldInstances?: { __identifier: string; __value: unknown }[];
}

/** Map layer */
interface LayerInstance {
  __identifier: string;
  __type: string;
  __gridSize: number;
  gridTiles?: GridTile[];
  entityInstances?: EntityInstance[];
}

/** Level data (LDtk-compatible format) */
interface LevelData {
  identifier: string;
  pxWid: number;
  pxHei: number;
  layerInstances: LayerInstance[];
}

/** Full map file */
interface MapFile {
  levels: LevelData[];
}

/** Tool types */
type Tool = 'select' | 'paint' | 'erase' | 'pan' | 'entity';

/** Layer being edited */
type EditLayer = 'terrain' | 'paths' | 'entities';

/** Asset info */
interface TileAsset {
  id: string;
  name: string;
  tileType?: string;
  terrainType?: string;
  variations?: number;
  bridgeAssetId?: string;
  imageUrl?: string;
  images?: Map<number, HTMLImageElement>;  // Loaded variation images
}

interface CharacterAsset {
  id: string;
  name: string;
  imageUrl?: string;
}

/** Image cache for tile rendering */
const imageCache = new Map<string, HTMLImageElement>();

/** Hexmanos UUID -> folder name mapping */
let hexmanosMapping: { characters?: Record<string, string>; objects?: Record<string, string> } = {};

async function loadHexmanosMapping(): Promise<void> {
  try {
    const response = await fetch('/mods/hexmanos-mapping.json');
    if (response.ok) {
      hexmanosMapping = await response.json();
    }
  } catch {
    // Mapping file not available
  }
}

/** Resolve UUID to folder name using hexmanos mapping */
function resolveEntityId(rawId: string): string {
  if (hexmanosMapping.characters?.[rawId]) return hexmanosMapping.characters[rawId];
  if (hexmanosMapping.objects?.[rawId]) return hexmanosMapping.objects[rawId];
  return rawId;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageCache.set(url, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Calculate path connectivity variation (0-14) based on neighboring paths
 * Bitmask: N=8, S=4, W=2, E=1
 */
function calculatePathVariation(
  x: number,
  y: number,
  pathGrid: Map<string, GridTile>,
  pathAssetId: string,
  mapWidth: number,
  mapHeight: number
): number {
  let bits = 0;

  const gridX = x / TILE_SIZE;
  const gridY = y / TILE_SIZE;

  // Check North (up)
  const northKey = `${x},${y - TILE_SIZE}`;
  if (gridY > 0 && pathGrid.get(northKey)?.src === pathAssetId) bits |= 8;

  // Check South (down)
  const southKey = `${x},${y + TILE_SIZE}`;
  if (gridY < mapHeight / TILE_SIZE - 1 && pathGrid.get(southKey)?.src === pathAssetId) bits |= 4;

  // Check West (left)
  const westKey = `${x - TILE_SIZE},${y}`;
  if (gridX > 0 && pathGrid.get(westKey)?.src === pathAssetId) bits |= 2;

  // Check East (right)
  const eastKey = `${x + TILE_SIZE},${y}`;
  if (gridX < mapWidth / TILE_SIZE - 1 && pathGrid.get(eastKey)?.src === pathAssetId) bits |= 1;

  // Convert to variation index (0-14)
  return bits === 0 ? 0 : bits - 1;
}

/**
 * Bresenham line algorithm - returns all cells between two points
 */
function getLineCells(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let x = x0;
  let y = y0;

  while (true) {
    cells.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }

  return cells;
}

/**
 * Get seeded random variation for terrain tiles
 */
function getVariationFromSeed(seed: number, variations: number): number {
  const x = Math.sin(seed * 9999) * 10000;
  const rand = x - Math.floor(x);
  return Math.floor(rand * variations);
}

/**
 * Direction offsets for transition calculations
 */
const DIRECTION_OFFSETS = {
  n:  { dx: 0,  dy: -1 },
  ne: { dx: 1,  dy: -1 },
  e:  { dx: 1,  dy: 0 },
  se: { dx: 1,  dy: 1 },
  s:  { dx: 0,  dy: 1 },
  sw: { dx: -1, dy: 1 },
  w:  { dx: -1, dy: 0 },
  nw: { dx: -1, dy: -1 }
} as const;

type TransitionDirection = keyof typeof DIRECTION_OFFSETS;
const ALL_DIRECTIONS: TransitionDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

/**
 * Get directions where this tile should project transitions onto neighbors
 * Dominant tile (higher assetId) wins when tiles are different
 */
function getTransitionDirections(
  x: number,
  y: number,
  terrainGrid: Map<string, GridTile>,
  mapWidth: number,
  mapHeight: number,
  tileAssetId: string
): TransitionDirection[] {
  const gridX = x / TILE_SIZE;
  const gridY = y / TILE_SIZE;
  const directions: TransitionDirection[] = [];

  for (const dir of ALL_DIRECTIONS) {
    const offset = DIRECTION_OFFSETS[dir];
    const nx = gridX + offset.dx;
    const ny = gridY + offset.dy;

    // Skip if neighbor is out of bounds
    if (nx < 0 || nx >= mapWidth / TILE_SIZE || ny < 0 || ny >= mapHeight / TILE_SIZE) continue;

    const neighborKey = `${nx * TILE_SIZE},${ny * TILE_SIZE}`;
    const neighbor = terrainGrid.get(neighborKey);

    // Determine if we should draw transition
    let shouldDraw = false;

    if (!neighbor) {
      // Neighbor is void - always draw transition
      shouldDraw = true;
    } else if (neighbor.src !== tileAssetId) {
      // Different tile - dominant tile (higher assetId) wins
      shouldDraw = tileAssetId > neighbor.src;
    }

    if (shouldDraw) {
      directions.push(dir);
    }
  }

  return directions;
}

/**
 * Map Editor - Full-featured level editor with path connectivity
 */
export function MapEditor() {
  // Current level data
  const [level, setLevel] = useState<LevelData>({
    identifier: 'new_map',
    pxWid: 2048,
    pxHei: 2048,
    layerInstances: [
      { __identifier: 'Terrain', __type: 'Tiles', __gridSize: TILE_SIZE, gridTiles: [] },
      { __identifier: 'Paths', __type: 'Tiles', __gridSize: TILE_SIZE, gridTiles: [] },
      { __identifier: 'Entities', __type: 'Entities', __gridSize: TILE_SIZE, entityInstances: [] },
    ],
  });

  // Editor state
  const [tool, setTool] = useState<Tool>('paint');
  const [editLayer, setEditLayer] = useState<EditLayer>('terrain');
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [entityType, setEntityType] = useState<'character' | 'object'>('character');
  const [showGrid, setShowGrid] = useState(true);
  const [cursorWorld, setCursorWorld] = useState({ x: 0, y: 0 });

  // Drawing state
  const isDrawingRef = useRef(false);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);

  // Asset lists
  const [tiles, setTiles] = useState<TileAsset[]>([]);
  const [pathTiles, setPathTiles] = useState<TileAsset[]>([]);
  const [bridgeTiles, setBridgeTiles] = useState<TileAsset[]>([]);
  const [characters, setCharacters] = useState<CharacterAsset[]>([]);
  const [objects, setObjects] = useState<CharacterAsset[]>([]);
  const [existingMaps, setExistingMaps] = useState<string[]>([]);
  const [currentMapName, setCurrentMapName] = useState<string | null>(null);
  const [selectedBridgeId, setSelectedBridgeId] = useState<string | null>(null);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tile images for rendering
  const tileImagesRef = useRef<Map<string, TileAsset>>(new Map());
  const [renderKey, setRenderKey] = useState(0);

  // Load available assets on mount
  useEffect(() => {
    loadHexmanosMapping();
    loadAssets();
    loadMapList();
  }, []);

  // Load all assets
  async function loadAssets() {
    const storage = createStorage();

    try {
      const tileFiles = await storage.list('tiles');
      const tileIds = [...new Set(
        tileFiles
          .filter(f => f.includes('/') && (f.endsWith('properties.json') || f.endsWith('definition.json')))
          .map(f => f.split('/')[1])
      )];

      const loadedTiles: TileAsset[] = [];
      const loadedPaths: TileAsset[] = [];
      const loadedBridges: TileAsset[] = [];

      for (const id of tileIds) {
        try {
          let props: Record<string, unknown> = {};
          try {
            const json = await storage.readText(`tiles/${id}/properties.json`);
            props = JSON.parse(json);
          } catch {
            const json = await storage.readText(`tiles/${id}/definition.json`);
            props = JSON.parse(json);
          }

          const tileType = (props.tileType as string) || 'TILE';
          const variations = (props.variations as number) || 1;
          const imageUrl = storage.getReadUrl(`tiles/${id}/tile_0.png`);

          const asset: TileAsset = {
            id,
            name: (props.name as string) || id,
            tileType,
            terrainType: props.terrainType as string,
            variations,
            bridgeAssetId: props.bridgeAssetId as string,
            imageUrl,
            images: new Map(),
          };

          // Preload all variation images for paths (15 variations) or terrain (1-8)
          const maxVar = tileType === 'PATH' || tileType === 'BRIDGE' ? 15 : variations;
          for (let v = 0; v < maxVar; v++) {
            const varUrl = storage.getReadUrl(`tiles/${id}/tile_${v}.png`);
            loadImage(varUrl).then(img => {
              asset.images!.set(v, img);
              tileImagesRef.current.set(id, asset);
              setRenderKey(k => k + 1);
            }).catch(() => {});
          }

          if (tileType === 'BRIDGE') {
            loadedBridges.push(asset);
          } else if (tileType === 'PATH') {
            loadedPaths.push(asset);
          } else {
            loadedTiles.push(asset);
          }

          tileImagesRef.current.set(id, asset);
        } catch (e) {
          console.warn(`Failed to load tile ${id}:`, e);
        }
      }

      setTiles(loadedTiles);
      setPathTiles(loadedPaths);
      setBridgeTiles(loadedBridges);
      if (loadedTiles.length > 0 && !selectedTileId) {
        setSelectedTileId(loadedTiles[0].id);
      }
      if (loadedBridges.length > 0 && !selectedBridgeId) {
        setSelectedBridgeId(loadedBridges[0].id);
      }
    } catch (e) {
      console.error('Failed to load tiles:', e);
    }

    // Load characters
    try {
      const charFiles = await storage.list('characters');
      const charIds = [...new Set(
        charFiles
          .filter(f => f.includes('/') && f.endsWith('definition.json'))
          .map(f => f.split('/')[1])
      )];

      const loadedChars: CharacterAsset[] = [];
      for (const id of charIds) {
        try {
          const json = await storage.readText(`characters/${id}/definition.json`);
          const def = JSON.parse(json);
          loadedChars.push({
            id,
            name: def.name || id,
            imageUrl: storage.getReadUrl(`characters/${id}/${id}_full_idle_south_0.png`),
          });
        } catch (e) {
          console.warn(`Failed to load character ${id}:`, e);
        }
      }
      setCharacters(loadedChars);
    } catch (e) {
      console.error('Failed to load characters:', e);
    }

    // Load objects
    try {
      const objFiles = await storage.list('objects');
      const objIds = [...new Set(
        objFiles
          .filter(f => f.includes('/') && f.endsWith('definition.json'))
          .map(f => f.split('/')[1])
      )];

      const loadedObjs: CharacterAsset[] = [];
      for (const id of objIds) {
        try {
          const json = await storage.readText(`objects/${id}/definition.json`);
          const def = JSON.parse(json);
          loadedObjs.push({
            id,
            name: def.name || id,
            imageUrl: storage.getReadUrl(`objects/${id}/${id}_idle_0.png`),
          });
        } catch (e) {
          console.warn(`Failed to load object ${id}:`, e);
        }
      }
      setObjects(loadedObjs);
    } catch (e) {
      console.error('Failed to load objects:', e);
    }
  }

  // Load map list
  async function loadMapList() {
    try {
      const storage = createStorage();
      const files = await storage.list('levels');
      // Files come back as "levels/test_map.json" - extract just the name
      const mapNames = files
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const parts = f.split('/');
          const filename = parts[parts.length - 1];
          return filename.replace('.json', '');
        })
        .filter(name => name && name !== '.gitkeep');
      setExistingMaps(mapNames);
    } catch (e) {
      console.error('Failed to load map list:', e);
    }
  }

  // Load a map from storage
  const loadMap = useCallback(async (name: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const storage = createStorage();
      const json = await storage.readText(`levels/${name}.json`);
      const mapFile: MapFile = JSON.parse(json);

      if (mapFile.levels && mapFile.levels.length > 0) {
        const loadedLevel = mapFile.levels[0];

        // Normalize layers - ensure we have Terrain, Paths, Entities
        const tilesLayer = loadedLevel.layerInstances.find(l => l.__identifier === 'Tiles' || l.__identifier === 'Terrain');
        const pathsLayer = loadedLevel.layerInstances.find(l => l.__identifier === 'Paths');
        const entitiesLayer = loadedLevel.layerInstances.find(l => l.__identifier === 'Entities');

        // Load tile definitions first to determine tile types
        const allTileIds = [...new Set((tilesLayer?.gridTiles || []).map(t => t.src))];
        for (const tileId of allTileIds) {
          if (!tileImagesRef.current.has(tileId)) {
            try {
              let props: Record<string, unknown> = {};
              try {
                const propsJson = await storage.readText(`tiles/${tileId}/properties.json`);
                props = JSON.parse(propsJson);
              } catch {
                const defJson = await storage.readText(`tiles/${tileId}/definition.json`);
                props = JSON.parse(defJson);
              }
              const asset: TileAsset = {
                id: tileId,
                name: (props.name as string) || tileId,
                tileType: (props.tileType as string) || 'TILE',
                terrainType: props.terrainType as string,
                variations: (props.variations as number) || 1,
                bridgeAssetId: props.bridgeAssetId as string,
                images: new Map(),
              };
              tileImagesRef.current.set(tileId, asset);
            } catch {
              // Tile definition not found - assume it's a terrain tile
            }
          }
        }

        // Now separate PATH tiles from terrain tiles
        const allTiles = tilesLayer?.gridTiles || [];
        const terrainTiles: GridTile[] = [];
        const pathTiles: GridTile[] = [];

        for (const tile of allTiles) {
          const asset = tileImagesRef.current.get(tile.src);
          if (asset?.tileType === 'PATH' || asset?.tileType === 'BRIDGE') {
            pathTiles.push(tile);
          } else {
            terrainTiles.push(tile);
          }
        }

        // Normalize entity instances - extract body_def_id from fieldInstances and resolve UUID
        const normalizedEntities = (entitiesLayer?.entityInstances || []).map(e => {
          // If entity already has defId, use it; otherwise extract from fieldInstances
          let rawId = (e as EntityInstance & { defId?: string }).defId;
          if (!rawId) {
            const bodyDefField = e.fieldInstances?.find(f => f.__identifier === 'body_def_id');
            rawId = (bodyDefField?.__value as string) || 'unknown';
          }
          // Resolve UUID to folder name using hexmanos mapping
          const resolvedId = resolveEntityId(rawId);
          return {
            ...e,
            defId: resolvedId,
          };
        });

        setLevel({
          identifier: loadedLevel.identifier,
          pxWid: loadedLevel.pxWid,
          pxHei: loadedLevel.pxHei,
          layerInstances: [
            { __identifier: 'Terrain', __type: 'Tiles', __gridSize: TILE_SIZE, gridTiles: terrainTiles },
            { __identifier: 'Paths', __type: 'Tiles', __gridSize: TILE_SIZE, gridTiles: pathsLayer?.gridTiles || pathTiles },
            { __identifier: 'Entities', __type: 'Entities', __gridSize: TILE_SIZE, entityInstances: normalizedEntities },
          ],
        });
        setCurrentMapName(name);
      }
    } catch (e) {
      setError(`Failed to load map: ${e}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save current map
  const saveMap = useCallback(async () => {
    const name = currentMapName || level.identifier;
    if (!name) {
      setError('Map name is required');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const storage = createStorage();

      // Combine terrain and paths into single Tiles layer for compatibility
      const terrainLayer = level.layerInstances.find(l => l.__identifier === 'Terrain');
      const pathsLayer = level.layerInstances.find(l => l.__identifier === 'Paths');
      const entitiesLayer = level.layerInstances.find(l => l.__identifier === 'Entities');

      const combinedTiles = [
        ...(terrainLayer?.gridTiles || []),
        ...(pathsLayer?.gridTiles || []),
      ];

      const exportLevel: LevelData = {
        identifier: level.identifier,
        pxWid: level.pxWid,
        pxHei: level.pxHei,
        layerInstances: [
          { __identifier: 'Tiles', __type: 'Tiles', __gridSize: TILE_SIZE, gridTiles: combinedTiles },
          { __identifier: 'Entities', __type: 'Entities', __gridSize: TILE_SIZE, entityInstances: entitiesLayer?.entityInstances || [] },
        ],
      };

      const mapFile: MapFile = { levels: [exportLevel] };
      await storage.writeText(`levels/${name}.json`, JSON.stringify(mapFile, null, 2));
      setCurrentMapName(name);

      if (!existingMaps.includes(name)) {
        setExistingMaps(prev => [...prev, name]);
      }
    } catch (e) {
      setError(`Failed to save map: ${e}`);
    } finally {
      setIsSaving(false);
    }
  }, [level, currentMapName, existingMaps]);

  // Create new map
  const newMap = useCallback(() => {
    setLevel({
      identifier: 'new_map',
      pxWid: 2048,
      pxHei: 2048,
      layerInstances: [
        { __identifier: 'Terrain', __type: 'Tiles', __gridSize: TILE_SIZE, gridTiles: [] },
        { __identifier: 'Paths', __type: 'Tiles', __gridSize: TILE_SIZE, gridTiles: [] },
        { __identifier: 'Entities', __type: 'Entities', __gridSize: TILE_SIZE, entityInstances: [] },
      ],
    });
    setCurrentMapName(null);
  }, []);

  // Snap to grid
  const snapToGrid = useCallback((x: number, y: number) => {
    const gridX = Math.floor(x / TILE_SIZE) * TILE_SIZE;
    const gridY = Math.floor(y / TILE_SIZE) * TILE_SIZE;
    return { x: gridX, y: gridY };
  }, []);

  // Paint a single cell
  const paintCell = useCallback((worldX: number, worldY: number) => {
    const snapped = snapToGrid(worldX, worldY);
    if (snapped.x < 0 || snapped.x >= level.pxWid || snapped.y < 0 || snapped.y >= level.pxHei) {
      return;
    }

    if (tool === 'paint' && selectedTileId) {
      const layerName = editLayer === 'terrain' ? 'Terrain' : 'Paths';
      const selectedAsset = tileImagesRef.current.get(selectedTileId);
      const isGroundPath = selectedAsset?.tileType === 'PATH' && selectedAsset?.terrainType !== 'WATER';

      setLevel(prev => {
        const layer = prev.layerInstances.find(l => l.__identifier === layerName);
        if (!layer || !layer.gridTiles) return prev;

        const existingIdx = layer.gridTiles.findIndex(
          t => t.px[0] === snapped.x && t.px[1] === snapped.y
        );

        const newTile: GridTile = {
          px: [snapped.x, snapped.y],
          t: Math.floor(Math.random() * 100),
          src: selectedTileId,
        };

        let newGridTiles: GridTile[];
        if (existingIdx >= 0) {
          newGridTiles = [...layer.gridTiles];
          newGridTiles[existingIdx] = newTile;
        } else {
          newGridTiles = [...layer.gridTiles, newTile];
        }

        let updatedLayers = prev.layerInstances.map(l =>
          l.__identifier === layerName ? { ...l, gridTiles: newGridTiles } : l
        );

        // Auto-add bridge when painting ground path over water
        if (isGroundPath && selectedBridgeId) {
          const terrainLayer = prev.layerInstances.find(l => l.__identifier === 'Terrain');
          const pathsLayer = prev.layerInstances.find(l => l.__identifier === 'Paths');

          // Check if there's water terrain or water path at this position
          const terrainTile = terrainLayer?.gridTiles?.find(
            t => t.px[0] === snapped.x && t.px[1] === snapped.y
          );
          const pathTile = pathsLayer?.gridTiles?.find(
            t => t.px[0] === snapped.x && t.px[1] === snapped.y
          );

          const terrainAsset = terrainTile ? tileImagesRef.current.get(terrainTile.src) : null;
          const pathAsset = pathTile ? tileImagesRef.current.get(pathTile.src) : null;

          const isOverWater =
            terrainAsset?.terrainType === 'WATER' ||
            (pathAsset?.tileType === 'PATH' && pathAsset?.terrainType === 'WATER');

          if (isOverWater) {
            // Add bridge tile to the Paths layer (rendered under ground paths)
            const bridgeTile: GridTile = {
              px: [snapped.x, snapped.y],
              t: Math.floor(Math.random() * 100),
              src: selectedBridgeId,
            };

            // Find or create bridges in paths layer (before ground paths)
            updatedLayers = updatedLayers.map(l => {
              if (l.__identifier === 'Paths') {
                // Check if there's already a bridge here
                const existingBridgeIdx = (l.gridTiles || []).findIndex(
                  t => t.px[0] === snapped.x && t.px[1] === snapped.y &&
                       tileImagesRef.current.get(t.src)?.tileType === 'BRIDGE'
                );

                if (existingBridgeIdx >= 0) {
                  // Update existing bridge
                  const updatedTiles = [...(l.gridTiles || [])];
                  updatedTiles[existingBridgeIdx] = bridgeTile;
                  return { ...l, gridTiles: updatedTiles };
                } else {
                  // Add new bridge
                  return { ...l, gridTiles: [...(l.gridTiles || []), bridgeTile] };
                }
              }
              return l;
            });
          }
        }

        return { ...prev, layerInstances: updatedLayers };
      });
    } else if (tool === 'erase') {
      const layerName = editLayer === 'terrain' ? 'Terrain' : 'Paths';

      setLevel(prev => ({
        ...prev,
        layerInstances: prev.layerInstances.map(l =>
          l.__identifier === layerName
            ? { ...l, gridTiles: (l.gridTiles || []).filter(t => t.px[0] !== snapped.x || t.px[1] !== snapped.y) }
            : l
        ),
      }));
    } else if (tool === 'entity' && selectedEntityId && editLayer === 'entities') {
      const newEntity: EntityInstance = {
        __identifier: entityType === 'character' ? 'Character' : 'Object',
        px: [Math.round(worldX), Math.round(worldY)],
        defId: selectedEntityId,
      };

      setLevel(prev => ({
        ...prev,
        layerInstances: prev.layerInstances.map(l =>
          l.__identifier === 'Entities'
            ? { ...l, entityInstances: [...(l.entityInstances || []), newEntity] }
            : l
        ),
      }));
    }
  }, [tool, selectedTileId, selectedEntityId, entityType, editLayer, level.pxWid, level.pxHei, snapToGrid, selectedBridgeId]);

  // Handle world mouse events
  const handleWorldMouseMove = useCallback((worldX: number, worldY: number) => {
    setCursorWorld({ x: worldX, y: worldY });

    // Continuous painting while dragging
    if (isDrawingRef.current && (tool === 'paint' || tool === 'erase')) {
      const snapped = snapToGrid(worldX, worldY);
      const gridCell = { x: snapped.x, y: snapped.y };

      if (lastCellRef.current && (lastCellRef.current.x !== gridCell.x || lastCellRef.current.y !== gridCell.y)) {
        // Use Bresenham line to fill gaps
        const cells = getLineCells(
          lastCellRef.current.x / TILE_SIZE,
          lastCellRef.current.y / TILE_SIZE,
          gridCell.x / TILE_SIZE,
          gridCell.y / TILE_SIZE
        );
        for (let i = 1; i < cells.length; i++) {
          paintCell(cells[i].x * TILE_SIZE, cells[i].y * TILE_SIZE);
        }
        lastCellRef.current = gridCell;
      }
    }
  }, [tool, snapToGrid, paintCell]);

  const handleWorldClick = useCallback((worldX: number, worldY: number, button: number) => {
    if (button !== 0) return;
    isDrawingRef.current = true;
    const snapped = snapToGrid(worldX, worldY);
    lastCellRef.current = { x: snapped.x, y: snapped.y };
    paintCell(worldX, worldY);
  }, [snapToGrid, paintCell]);

  const handleWorldMouseUp = useCallback(() => {
    isDrawingRef.current = false;
    lastCellRef.current = null;
  }, []);

  // Render callback
  const handleRender = useCallback((ctx: CanvasRenderingContext2D, _transform: { scale: number }) => {
    const terrainLayer = level.layerInstances.find(l => l.__identifier === 'Terrain');
    const pathsLayer = level.layerInstances.find(l => l.__identifier === 'Paths');
    const entitiesLayer = level.layerInstances.find(l => l.__identifier === 'Entities');

    // Build path grid for connectivity calculation
    const pathGrid = new Map<string, GridTile>();
    if (pathsLayer?.gridTiles) {
      for (const tile of pathsLayer.gridTiles) {
        pathGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
      }
    }

    // Build terrain grid for transition calculations
    const terrainGrid = new Map<string, GridTile>();
    if (terrainLayer?.gridTiles) {
      for (const tile of terrainLayer.gridTiles) {
        terrainGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
      }
    }

    // Pass 1: Draw terrain tiles
    if (terrainLayer?.gridTiles) {
      for (const tile of terrainLayer.gridTiles) {
        const asset = tileImagesRef.current.get(tile.src);
        if (asset?.images) {
          const variation = getVariationFromSeed(tile.t || 0, asset.variations || 1);
          const img = asset.images.get(variation) || asset.images.get(0);
          if (img) {
            ctx.drawImage(img, tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
          } else {
            ctx.fillStyle = getTileColor(tile.src);
            ctx.fillRect(tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
          }
        } else {
          ctx.fillStyle = getTileColor(tile.src);
          ctx.fillRect(tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
        }
      }
    }

    // Pass 1.5: Draw terrain transitions (Stacking Algorithm)
    if (terrainLayer?.gridTiles) {
      for (const tile of terrainLayer.gridTiles) {
        const directions = getTransitionDirections(
          tile.px[0], tile.px[1],
          terrainGrid,
          level.pxWid, level.pxHei,
          tile.src
        );

        for (const dir of directions) {
          const offset = DIRECTION_OFFSETS[dir];
          const nx = tile.px[0] + offset.dx * TILE_SIZE;
          const ny = tile.px[1] + offset.dy * TILE_SIZE;

          // Load transition image
          const storage = createStorage();
          const transitionUrl = storage.getReadUrl(`tiles/${tile.src}/tile_0_transition_${dir}.png`);
          const transitionImg = imageCache.get(transitionUrl);

          if (transitionImg) {
            ctx.drawImage(transitionImg, nx, ny, TILE_SIZE, TILE_SIZE);
          } else {
            // Start loading the transition image
            loadImage(transitionUrl).then(() => setRenderKey(k => k + 1)).catch(() => {});
          }
        }
      }
    }

    // Separate paths by type: water paths, bridges, ground paths
    const waterPaths: GridTile[] = [];
    const bridges: GridTile[] = [];
    const groundPaths: GridTile[] = [];

    if (pathsLayer?.gridTiles) {
      for (const tile of pathsLayer.gridTiles) {
        const asset = tileImagesRef.current.get(tile.src);
        if (asset?.tileType === 'BRIDGE') {
          bridges.push(tile);
        } else if (asset?.terrainType === 'WATER') {
          waterPaths.push(tile);
        } else {
          groundPaths.push(tile);
        }
      }
    }

    // Build separate grids for connectivity
    const waterPathGrid = new Map<string, GridTile>();
    for (const tile of waterPaths) {
      waterPathGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
    }
    const groundPathGrid = new Map<string, GridTile>();
    for (const tile of groundPaths) {
      groundPathGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
    }

    // Pass 2a: Draw water paths (rivers) with connectivity
    for (const tile of waterPaths) {
      const asset = tileImagesRef.current.get(tile.src);
      if (asset?.images) {
        const variation = calculatePathVariation(
          tile.px[0], tile.px[1],
          waterPathGrid, tile.src,
          level.pxWid, level.pxHei
        );
        const img = asset.images.get(variation) || asset.images.get(0);
        if (img) {
          ctx.drawImage(img, tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
        }
      }
    }

    // Pass 2b: Draw bridges with connectivity (based on ground paths above)
    for (const tile of bridges) {
      const asset = tileImagesRef.current.get(tile.src);
      if (asset?.images) {
        // Calculate bridge variation based on neighboring ground paths
        let bits = 0;
        const x = tile.px[0];
        const y = tile.px[1];
        const gridX = x / TILE_SIZE;
        const gridY = y / TILE_SIZE;

        if (gridY > 0 && groundPathGrid.has(`${x},${y - TILE_SIZE}`)) bits |= 8;
        if (gridY < level.pxHei / TILE_SIZE - 1 && groundPathGrid.has(`${x},${y + TILE_SIZE}`)) bits |= 4;
        if (gridX > 0 && groundPathGrid.has(`${x - TILE_SIZE},${y}`)) bits |= 2;
        if (gridX < level.pxWid / TILE_SIZE - 1 && groundPathGrid.has(`${x + TILE_SIZE},${y}`)) bits |= 1;

        const variation = bits === 0 ? 0 : bits - 1;
        const img = asset.images.get(variation) || asset.images.get(0);
        if (img) {
          ctx.drawImage(img, tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
        }
      }
    }

    // Pass 2c: Draw ground paths with connectivity
    for (const tile of groundPaths) {
      const asset = tileImagesRef.current.get(tile.src);
      if (asset?.images) {
        const variation = calculatePathVariation(
          tile.px[0], tile.px[1],
          groundPathGrid, tile.src,
          level.pxWid, level.pxHei
        );
        const img = asset.images.get(variation) || asset.images.get(0);
        if (img) {
          ctx.drawImage(img, tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
        }
      }
    }

    // Pass 3: Draw entities
    if (entitiesLayer?.entityInstances) {
      for (const entity of entitiesLayer.entityInstances) {
        const isCharacter = entity.__identifier === 'Character';
        ctx.fillStyle = isCharacter ? '#4ecca3' : '#ffd93d';
        ctx.beginPath();
        ctx.arc(entity.px[0], entity.px[1], 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(entity.defId, entity.px[0], entity.px[1] + 40);
      }
    }

    // Draw cursor preview
    const snapped = snapToGrid(cursorWorld.x, cursorWorld.y);
    if (tool === 'paint' && selectedTileId) {
      if (snapped.x >= 0 && snapped.x < level.pxWid && snapped.y >= 0 && snapped.y < level.pxHei) {
        const asset = tileImagesRef.current.get(selectedTileId);
        const img = asset?.images?.get(0);
        if (img) {
          ctx.globalAlpha = 0.5;
          ctx.drawImage(img, snapped.x, snapped.y, TILE_SIZE, TILE_SIZE);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = '#4ecca3';
        ctx.lineWidth = 2;
        ctx.strokeRect(snapped.x, snapped.y, TILE_SIZE, TILE_SIZE);
      }
    } else if (tool === 'erase') {
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.strokeRect(snapped.x, snapped.y, TILE_SIZE, TILE_SIZE);
      ctx.fillStyle = 'rgba(255, 107, 107, 0.2)';
      ctx.fillRect(snapped.x, snapped.y, TILE_SIZE, TILE_SIZE);
    } else if (tool === 'entity' && selectedEntityId) {
      ctx.fillStyle = 'rgba(78, 204, 163, 0.5)';
      ctx.beginPath();
      ctx.arc(cursorWorld.x, cursorWorld.y, 24, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [level, tool, selectedTileId, selectedEntityId, cursorWorld, snapToGrid, renderKey]);

  // Tile counts
  const terrainCount = level.layerInstances.find(l => l.__identifier === 'Terrain')?.gridTiles?.length || 0;
  const pathCount = level.layerInstances.find(l => l.__identifier === 'Paths')?.gridTiles?.length || 0;
  const entityCount = level.layerInstances.find(l => l.__identifier === 'Entities')?.entityInstances?.length || 0;

  // Select tile based on layer
  const activeTiles = editLayer === 'paths' ? pathTiles : tiles;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar */}
      <div style={{ width: 220, background: '#16213e', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto' }}>
        {/* Map list */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <h4 style={{ color: '#4ecca3', margin: 0, flex: 1, fontSize: '0.875rem' }}>Maps</h4>
            <button onClick={newMap} title="New Map" style={iconBtnStyle}><Plus size={14} /></button>
          </div>
          <div style={{ maxHeight: 120, overflowY: 'auto', background: '#0f0f23', borderRadius: '4px', padding: '0.25rem' }}>
            {existingMaps.map(name => (
              <div
                key={name}
                onClick={() => loadMap(name)}
                style={{
                  padding: '0.25rem 0.5rem',
                  background: currentMapName === name ? '#4ecca3' : 'transparent',
                  color: currentMapName === name ? '#1a1a2e' : '#ccc',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.7rem',
                  marginBottom: '2px',
                }}
              >
                {name}
              </div>
            ))}
            {existingMaps.length === 0 && <span style={{ color: '#666', fontSize: '0.7rem' }}>No maps yet</span>}
          </div>
        </div>

        {/* Layers */}
        <div>
          <h4 style={{ color: '#888', margin: '0 0 0.25rem 0', fontSize: '0.75rem' }}>Layer</h4>
          <div style={{ display: 'flex', gap: '2px' }}>
            {(['terrain', 'paths', 'entities'] as EditLayer[]).map(layer => (
              <button
                key={layer}
                onClick={() => {
                  setEditLayer(layer);
                  if (layer === 'entities') setTool('entity');
                  else setTool('paint');
                }}
                style={{
                  flex: 1,
                  padding: '0.25rem',
                  border: 'none',
                  borderRadius: '4px',
                  background: editLayer === layer ? '#4ecca3' : '#0f0f23',
                  color: editLayer === layer ? '#1a1a2e' : '#ccc',
                  cursor: 'pointer',
                  fontSize: '0.65rem',
                  textTransform: 'capitalize',
                }}
              >
                {layer}
              </button>
            ))}
          </div>
        </div>

        {/* Tools */}
        <div>
          <h4 style={{ color: '#888', margin: '0 0 0.25rem 0', fontSize: '0.75rem' }}>Tools</h4>
          <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap' }}>
            {[
              { id: 'select' as Tool, icon: MousePointer, label: 'Select' },
              { id: 'paint' as Tool, icon: Pencil, label: 'Paint' },
              { id: 'erase' as Tool, icon: Eraser, label: 'Erase' },
              { id: 'entity' as Tool, icon: Users, label: 'Entity' },
              { id: 'pan' as Tool, icon: Move, label: 'Pan' },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => setTool(t.id)}
                title={t.label}
                style={{ ...iconBtnStyle, background: tool === t.id ? '#4ecca3' : '#0f0f23', color: tool === t.id ? '#1a1a2e' : '#ccc' }}
              >
                <t.icon size={14} />
              </button>
            ))}
          </div>
        </div>

        {/* Tile palette */}
        {(editLayer === 'terrain' || editLayer === 'paths') && (
          <div>
            <h4 style={{ color: '#888', margin: '0 0 0.25rem 0', fontSize: '0.75rem' }}>
              {editLayer === 'paths' ? 'Paths' : 'Tiles'}
            </h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: 180, overflowY: 'auto' }}>
              {activeTiles.map(tile => (
                <TileThumbnail key={tile.id} tile={tile} selected={selectedTileId === tile.id} onClick={() => setSelectedTileId(tile.id)} />
              ))}
              {activeTiles.length === 0 && (
                <span style={{ color: '#666', fontSize: '0.7rem' }}>
                  No {editLayer === 'paths' ? 'path tiles' : 'tiles'}. Create in Tile Editor.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Bridge selector (for auto-bridging over water) */}
        {editLayer === 'paths' && bridgeTiles.length > 0 && (
          <div>
            <h4 style={{ color: '#888', margin: '0 0 0.25rem 0', fontSize: '0.75rem' }}>
              Auto-Bridge
            </h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: 80, overflowY: 'auto' }}>
              {bridgeTiles.map(tile => (
                <TileThumbnail key={tile.id} tile={tile} selected={selectedBridgeId === tile.id} onClick={() => setSelectedBridgeId(tile.id)} />
              ))}
            </div>
            <span style={{ color: '#666', fontSize: '0.6rem', marginTop: '0.25rem', display: 'block' }}>
              Auto-placed under land paths crossing water
            </span>
          </div>
        )}

        {/* Entity palette */}
        {editLayer === 'entities' && (
          <div>
            <div style={{ display: 'flex', gap: '2px', marginBottom: '0.25rem' }}>
              <button onClick={() => setEntityType('character')} style={{ flex: 1, padding: '0.2rem', border: 'none', borderRadius: '4px', background: entityType === 'character' ? '#4ecca3' : '#0f0f23', color: entityType === 'character' ? '#1a1a2e' : '#ccc', cursor: 'pointer', fontSize: '0.65rem' }}>Characters</button>
              <button onClick={() => setEntityType('object')} style={{ flex: 1, padding: '0.2rem', border: 'none', borderRadius: '4px', background: entityType === 'object' ? '#4ecca3' : '#0f0f23', color: entityType === 'object' ? '#1a1a2e' : '#ccc', cursor: 'pointer', fontSize: '0.65rem' }}>Objects</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: 180, overflowY: 'auto' }}>
              {(entityType === 'character' ? characters : objects).map(entity => (
                <EntityThumbnail key={entity.id} entity={entity} selected={selectedEntityId === entity.id} onClick={() => setSelectedEntityId(entity.id)} />
              ))}
            </div>
          </div>
        )}

        <div style={{ flex: 1 }} />

        <button onClick={saveMap} disabled={isSaving} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.5rem', background: isSaving ? '#555' : '#4ecca3', color: isSaving ? '#999' : '#1a1a2e', border: 'none', borderRadius: '4px', cursor: isSaving ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}>
          <Save size={14} />{isSaving ? 'Saving...' : 'Save Map'}
        </button>
        {error && <div style={{ color: '#ff6b6b', fontSize: '0.7rem' }}>{error}</div>}
      </div>

      {/* Main canvas */}
      <div style={{ flex: 1, position: 'relative' }} onMouseUp={handleWorldMouseUp} onMouseLeave={handleWorldMouseUp}>
        <PanZoomCanvas
          width={level.pxWid}
          height={level.pxHei}
          showGrid={showGrid}
          gridSize={TILE_SIZE}
          onRender={handleRender}
          onWorldMouseMove={handleWorldMouseMove}
          onWorldClick={handleWorldClick}
          style={{ width: '100%', height: '100%' }}
        />
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '0.5rem 1rem', background: 'rgba(0, 0, 0, 0.8)', color: '#888', fontSize: '0.7rem', display: 'flex', gap: '1.5rem' }}>
          <span>Map: {currentMapName || level.identifier}</span>
          <span>Layer: {editLayer}</span>
          <span>Terrain: {terrainCount}</span>
          <span>Paths: {pathCount}</span>
          <span>Entities: {entityCount}</span>
        </div>
      </div>

      {/* Right sidebar */}
      <div style={{ width: 160, background: '#16213e', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <h4 style={{ color: '#4ecca3', margin: 0, fontSize: '0.875rem' }}>Level</h4>
        <label style={{ color: '#888', fontSize: '0.65rem' }}>Name</label>
        <input type="text" value={level.identifier} onChange={e => setLevel(prev => ({ ...prev, identifier: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))} style={inputStyle} />
        <label style={{ color: '#888', fontSize: '0.65rem' }}>Width (tiles)</label>
        <input type="number" value={level.pxWid / TILE_SIZE} onChange={e => setLevel(prev => ({ ...prev, pxWid: Math.max(4, parseInt(e.target.value) || 16) * TILE_SIZE }))} min={4} max={256} style={inputStyle} />
        <label style={{ color: '#888', fontSize: '0.65rem' }}>Height (tiles)</label>
        <input type="number" value={level.pxHei / TILE_SIZE} onChange={e => setLevel(prev => ({ ...prev, pxHei: Math.max(4, parseInt(e.target.value) || 16) * TILE_SIZE }))} min={4} max={256} style={inputStyle} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.5rem' }}>
          <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />
          <span style={{ color: '#888', fontSize: '0.7rem' }}>Show Grid</span>
        </label>
      </div>

      {isLoading && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ color: '#4ecca3', fontSize: '1.5rem' }}>Loading...</div>
        </div>
      )}
    </div>
  );
}

function TileThumbnail({ tile, selected, onClick }: { tile: TileAsset; selected: boolean; onClick: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div onClick={onClick} title={`${tile.name} (${tile.id})`} style={{ width: 36, height: 36, border: selected ? '2px solid #4ecca3' : '1px solid #333', borderRadius: '4px', cursor: 'pointer', overflow: 'hidden', background: '#0f0f23', position: 'relative' }}>
      {tile.imageUrl && <img src={tile.imageUrl} alt={tile.name} onLoad={() => setLoaded(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated', display: loaded ? 'block' : 'none' }} />}
      {!loaded && <div style={{ width: '100%', height: '100%', background: getTileColor(tile.id) }} />}
      {tile.tileType === 'PATH' && <div style={{ position: 'absolute', bottom: 1, right: 1, width: 5, height: 5, borderRadius: '50%', background: '#ffd93d' }} />}
      {tile.terrainType === 'WATER' && <div style={{ position: 'absolute', top: 1, right: 1, width: 5, height: 5, borderRadius: '50%', background: '#4169e1' }} />}
    </div>
  );
}

function EntityThumbnail({ entity, selected, onClick }: { entity: CharacterAsset; selected: boolean; onClick: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div onClick={onClick} title={`${entity.name} (${entity.id})`} style={{ width: 36, height: 36, border: selected ? '2px solid #4ecca3' : '1px solid #333', borderRadius: '4px', cursor: 'pointer', overflow: 'hidden', background: '#0f0f23', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {entity.imageUrl && <img src={entity.imageUrl} alt={entity.name} onLoad={() => setLoaded(true)} onError={() => setLoaded(false)} style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated', display: loaded ? 'block' : 'none' }} />}
      {!loaded && <span style={{ color: '#666', fontSize: '0.5rem', textAlign: 'center' }}>{entity.id.slice(0, 3)}</span>}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = { width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#0f0f23', color: '#ccc', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const inputStyle: React.CSSProperties = { padding: '0.25rem 0.5rem', background: '#0f0f23', color: '#ccc', border: '1px solid #333', borderRadius: '4px', fontSize: '0.7rem', width: '100%' };
function getTileColor(id: string): string { let hash = 0; for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash); return `hsl(${hash % 360}, 60%, 40%)`; }

export default MapEditor;
