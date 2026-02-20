import { useCallback, useEffect, useState, useRef } from 'react';
import { PanZoomCanvas } from './PanZoomCanvas';
import { createStorage } from '../storage';

// ============================================================================
// Types
// ============================================================================

const TILE_SIZE = 128;

interface TileDefinition {
  id: string;
  name: string;
  tileType: 'TILE' | 'PATH' | 'BRIDGE';
  terrainType?: 'LAND' | 'WATER';
  variations?: number;
  bridgeAssetId?: string;
}

interface GridTile {
  px: [number, number];
  t: number | null;
  src: string;
}

interface EntityInstance {
  __identifier: string;
  px: [number, number];
  defId?: string;
  fieldInstances?: { __identifier: string; __value: unknown }[];
}

/** Hexmanos ID mapping (loaded at runtime) */
let hexmanosMapping: { characters?: Record<string, string>; objects?: Record<string, string> } = {};

/** Load hexmanos mapping file */
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

/** Extract body_def_id from entity - handles UUID mapping and fieldInstances */
function getEntityBodyId(entity: EntityInstance): string {
  let rawId = entity.defId;
  if (!rawId) {
    const bodyField = entity.fieldInstances?.find(f => f.__identifier === 'body_def_id');
    rawId = bodyField?.__value as string;
  }
  if (!rawId) return 'unknown';

  // Check mapping for UUID -> folder name
  if (hexmanosMapping.characters?.[rawId]) return hexmanosMapping.characters[rawId];
  if (hexmanosMapping.objects?.[rawId]) return hexmanosMapping.objects[rawId];

  return rawId;
}

interface LayerInstance {
  __identifier: string;
  __type: string;
  __gridSize: number;
  gridTiles?: GridTile[];
  entityInstances?: EntityInstance[];
}

interface LevelData {
  identifier: string;
  pxWid: number;
  pxHei: number;
  layerInstances: LayerInstance[];
}

interface MapFile {
  levels: LevelData[];
}

interface GameCanvasProps {
  levelId?: string;
  onEntityClick?: (entity: EntityInstance) => void;
  className?: string;
  style?: React.CSSProperties;
}

// ============================================================================
// Image Cache
// ============================================================================

const imageCache = new Map<string, HTMLImageElement>();

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

// ============================================================================
// Path Connectivity
// ============================================================================

/**
 * Calculate path variation (0-14) based on neighbors
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

// Transition image cache
const transitionImageCache = new Map<string, HTMLImageElement>();

// ============================================================================
// Component
// ============================================================================

export function GameCanvas({
  levelId,
  onEntityClick,
  className,
  style,
}: GameCanvasProps) {
  const [level, setLevel] = useState<LevelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tile definitions (loaded from storage)
  const tileDefsRef = useRef<Map<string, TileDefinition>>(new Map());

  // Tile images per variation
  const tileImagesRef = useRef<Map<string, Map<number, HTMLImageElement>>>(new Map());

  // Character images
  const charImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());

  // Animation state
  const [animationTick, setAnimationTick] = useState(0);
  const [renderKey, setRenderKey] = useState(0);

  // Animation timer
  useEffect(() => {
    const interval = setInterval(() => {
      setAnimationTick((t) => t + 1);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Load tile definitions and mapping on mount
  useEffect(() => {
    loadHexmanosMapping();
    loadTileDefinitions();
  }, []);

  async function loadTileDefinitions() {
    const storage = createStorage();
    try {
      const tileFiles = await storage.list('tiles');
      const tileIds = [...new Set(
        tileFiles
          .filter(f => f.includes('/') && (f.endsWith('properties.json') || f.endsWith('definition.json')))
          .map(f => f.split('/')[1])
      )];

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

          const def: TileDefinition = {
            id,
            name: (props.name as string) || id,
            tileType: (props.tileType as TileDefinition['tileType']) || 'TILE',
            terrainType: props.terrainType as TileDefinition['terrainType'],
            variations: (props.variations as number) || 1,
            bridgeAssetId: props.bridgeAssetId as string,
          };

          tileDefsRef.current.set(id, def);

          // Preload tile images
          const maxVar = def.tileType === 'PATH' || def.tileType === 'BRIDGE' ? 15 : def.variations!;
          const images = new Map<number, HTMLImageElement>();
          tileImagesRef.current.set(id, images);

          for (let v = 0; v < maxVar; v++) {
            const url = storage.getReadUrl(`tiles/${id}/tile_${v}.png`);
            loadImage(url).then(img => {
              images.set(v, img);
              setRenderKey(k => k + 1);
            }).catch(() => {});
          }
        } catch (e) {
          console.warn(`Failed to load tile definition ${id}:`, e);
        }
      }
    } catch (e) {
      console.error('Failed to load tile definitions:', e);
    }
  }

  // Load level
  useEffect(() => {
    if (!levelId) {
      setLevel(null);
      return;
    }

    async function loadLevel() {
      setLoading(true);
      setError(null);

      try {
        const storage = createStorage();
        const json = await storage.readText(`levels/${levelId}.json`);
        const mapFile: MapFile = JSON.parse(json);

        if (mapFile.levels && mapFile.levels.length > 0) {
          const loadedLevel = mapFile.levels[0];
          setLevel(loadedLevel);

          // Load character/object images for entities
          const entitiesLayer = loadedLevel.layerInstances.find(l => l.__identifier === 'Entities');
          if (entitiesLayer?.entityInstances) {
            for (const entity of entitiesLayer.entityInstances) {
              const charId = getEntityBodyId(entity);
              if (charId !== 'unknown' && !charImagesRef.current.has(charId)) {
                // Try characters folder first (with visual state prefix)
                const charUrl = storage.getReadUrl(`characters/${charId}/${charId}_full_idle_south_0.png`);
                loadImage(charUrl).then(img => {
                  charImagesRef.current.set(charId, img);
                  setRenderKey(k => k + 1);
                }).catch(() => {
                  // Try objects folder (with new/idle animation)
                  const objUrl = storage.getReadUrl(`objects/${charId}/${charId}_new_idle_0.png`);
                  loadImage(objUrl).then(img => {
                    charImagesRef.current.set(charId, img);
                    setRenderKey(k => k + 1);
                  }).catch(() => {
                    // Neither exists - fallback will show circle
                  });
                });
              }
            }
          }
        }
      } catch (e) {
        setError(`Failed to load level: ${e}`);
      } finally {
        setLoading(false);
      }
    }

    loadLevel();
  }, [levelId]);

  // Render callback
  const handleRender = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!level) return;

      const tilesLayer = level.layerInstances.find(l => l.__identifier === 'Tiles' || l.__identifier === 'Terrain');
      const pathsLayer = level.layerInstances.find(l => l.__identifier === 'Paths');
      const entitiesLayer = level.layerInstances.find(l => l.__identifier === 'Entities');

      // Separate terrain tiles and path tiles from the combined Tiles layer
      const allTiles = tilesLayer?.gridTiles || [];
      const terrainTiles: GridTile[] = [];
      const pathTiles: GridTile[] = [];
      const bridgeTiles: GridTile[] = [];

      for (const tile of allTiles) {
        const def = tileDefsRef.current.get(tile.src);
        if (def?.tileType === 'PATH') {
          pathTiles.push(tile);
        } else if (def?.tileType === 'BRIDGE') {
          bridgeTiles.push(tile);
        } else {
          terrainTiles.push(tile);
        }
      }

      // Add separate Paths layer tiles if they exist
      if (pathsLayer?.gridTiles) {
        for (const tile of pathsLayer.gridTiles) {
          const def = tileDefsRef.current.get(tile.src);
          if (def?.tileType === 'BRIDGE') {
            bridgeTiles.push(tile);
          } else {
            pathTiles.push(tile);
          }
        }
      }

      // Build path grid for connectivity calculation
      const pathGrid = new Map<string, GridTile>();
      for (const tile of pathTiles) {
        pathGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
      }

      // Build terrain grid for bridge detection
      const terrainGrid = new Map<string, GridTile>();
      for (const tile of terrainTiles) {
        terrainGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
      }

      // Detect where bridges are needed (ground paths over water terrain/paths)
      const waterPathGrid = new Map<string, GridTile>();
      const groundPathGrid = new Map<string, GridTile>();

      for (const tile of pathTiles) {
        const def = tileDefsRef.current.get(tile.src);
        if (def?.terrainType === 'WATER') {
          waterPathGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
        } else {
          groundPathGrid.set(`${tile.px[0]},${tile.px[1]}`, tile);
        }
      }

      // Find bridges to render (ground paths over water)
      const autoBridges: { tile: GridTile; bridgeAssetId: string }[] = [];
      for (const tile of pathTiles) {
        const def = tileDefsRef.current.get(tile.src);
        if (def?.terrainType !== 'WATER' && def?.bridgeAssetId) {
          const key = `${tile.px[0]},${tile.px[1]}`;
          const terrainBelow = terrainGrid.get(key);
          const terrainDef = terrainBelow ? tileDefsRef.current.get(terrainBelow.src) : null;
          const waterPathBelow = waterPathGrid.get(key);

          // If this ground path is over water terrain or water path, add bridge
          if (terrainDef?.terrainType === 'WATER' || waterPathBelow) {
            autoBridges.push({ tile, bridgeAssetId: def.bridgeAssetId });
          }
        }
      }

      // Build terrain grid for transition calculations
      const terrainGridForTransitions = new Map<string, GridTile>();
      for (const tile of terrainTiles) {
        terrainGridForTransitions.set(`${tile.px[0]},${tile.px[1]}`, tile);
      }

      // ========== RENDER PASS 1: Terrain ==========
      for (const tile of terrainTiles) {
        const def = tileDefsRef.current.get(tile.src);
        const images = tileImagesRef.current.get(tile.src);

        if (images && def) {
          const variation = getVariationFromSeed(tile.t || 0, def.variations || 1);
          const img = images.get(variation) || images.get(0);
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

      // ========== RENDER PASS 1.5: Terrain Transitions ==========
      const storage = createStorage();
      for (const tile of terrainTiles) {
        const directions = getTransitionDirections(
          tile.px[0], tile.px[1],
          terrainGridForTransitions,
          level.pxWid, level.pxHei,
          tile.src
        );

        for (const dir of directions) {
          const offset = DIRECTION_OFFSETS[dir];
          const nx = tile.px[0] + offset.dx * TILE_SIZE;
          const ny = tile.px[1] + offset.dy * TILE_SIZE;

          const transitionUrl = storage.getReadUrl(`tiles/${tile.src}/tile_0_transition_${dir}.png`);
          let transitionImg = transitionImageCache.get(transitionUrl);

          if (transitionImg) {
            ctx.drawImage(transitionImg, nx, ny, TILE_SIZE, TILE_SIZE);
          } else {
            // Start loading the transition image
            loadImage(transitionUrl).then(img => {
              transitionImageCache.set(transitionUrl, img);
              setRenderKey(k => k + 1);
            }).catch(() => {});
          }
        }
      }

      // ========== RENDER PASS 2: Water Paths (rivers) with connectivity ==========
      for (const [, tile] of waterPathGrid) {
        const images = tileImagesRef.current.get(tile.src);

        if (images) {
          const variation = calculatePathVariation(
            tile.px[0], tile.px[1],
            waterPathGrid, tile.src,
            level.pxWid, level.pxHei
          );
          const img = images.get(variation) || images.get(0);
          if (img) {
            ctx.drawImage(img, tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
          }
        }
      }

      // ========== RENDER PASS 3: Auto-bridges (under ground paths) ==========
      // Store both bridge asset and source path type for connectivity matching
      const bridgeGrid = new Map<string, { bridgeSrc: string; pathSrc: string; px: [number, number] }>();
      for (const { tile, bridgeAssetId } of autoBridges) {
        bridgeGrid.set(`${tile.px[0]},${tile.px[1]}`, {
          bridgeSrc: bridgeAssetId,
          pathSrc: tile.src, // The path type above this bridge
          px: tile.px
        });
      }
      // Add explicit bridge tiles
      for (const tile of bridgeTiles) {
        // For explicit bridges, find the ground path above to get the path type
        const groundPathAbove = groundPathGrid.get(`${tile.px[0]},${tile.px[1]}`);
        bridgeGrid.set(`${tile.px[0]},${tile.px[1]}`, {
          bridgeSrc: tile.src,
          pathSrc: groundPathAbove?.src || '',
          px: tile.px
        });
      }

      for (const [, bridge] of bridgeGrid) {
        const images = tileImagesRef.current.get(bridge.bridgeSrc);
        if (images) {
          // Calculate bridge connectivity based on neighboring ground paths OF THE SAME TYPE
          let bits = 0;
          const x = bridge.px[0];
          const y = bridge.px[1];
          const gridX = x / TILE_SIZE;
          const gridY = y / TILE_SIZE;

          // Only connect if neighbor has the same path type
          const northPath = groundPathGrid.get(`${x},${y - TILE_SIZE}`);
          const southPath = groundPathGrid.get(`${x},${y + TILE_SIZE}`);
          const westPath = groundPathGrid.get(`${x - TILE_SIZE},${y}`);
          const eastPath = groundPathGrid.get(`${x + TILE_SIZE},${y}`);

          if (gridY > 0 && northPath?.src === bridge.pathSrc) bits |= 8;
          if (gridY < level.pxHei / TILE_SIZE - 1 && southPath?.src === bridge.pathSrc) bits |= 4;
          if (gridX > 0 && westPath?.src === bridge.pathSrc) bits |= 2;
          if (gridX < level.pxWid / TILE_SIZE - 1 && eastPath?.src === bridge.pathSrc) bits |= 1;

          const bridgeVariation = bits === 0 ? 0 : bits - 1;
          const img = images.get(bridgeVariation) || images.get(0);
          if (img) {
            ctx.drawImage(img, bridge.px[0], bridge.px[1], TILE_SIZE, TILE_SIZE);
          }
        }
      }

      // ========== RENDER PASS 4: Ground Paths with connectivity ==========
      for (const [, tile] of groundPathGrid) {
        const images = tileImagesRef.current.get(tile.src);

        if (images) {
          const variation = calculatePathVariation(
            tile.px[0], tile.px[1],
            groundPathGrid, tile.src,
            level.pxWid, level.pxHei
          );
          const img = images.get(variation) || images.get(0);
          if (img) {
            ctx.drawImage(img, tile.px[0], tile.px[1], TILE_SIZE, TILE_SIZE);
          }
        }
      }

      // ========== RENDER PASS 5: Entities ==========
      if (entitiesLayer?.entityInstances) {
        for (const entity of entitiesLayer.entityInstances) {
          const charId = getEntityBodyId(entity);
          const img = charImagesRef.current.get(charId);

          if (img) {
            // Draw character sprite centered on position
            ctx.drawImage(
              img,
              entity.px[0] - TILE_SIZE / 2,
              entity.px[1] - TILE_SIZE / 2,
              TILE_SIZE,
              TILE_SIZE
            );
          } else {
            // Fallback: colored circle
            const isCharacter = entity.__identifier === 'Character';
            ctx.fillStyle = isCharacter ? '#4ecca3' : '#ffd93d';
            ctx.beginPath();
            ctx.arc(entity.px[0], entity.px[1], 24, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
          }

          // Draw entity label
          ctx.fillStyle = '#fff';
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(charId, entity.px[0], entity.px[1] + 48);
        }
      }
    },
    [level, animationTick, renderKey]
  );

  // Handle entity click
  const handleWorldClick = useCallback(
    (worldX: number, worldY: number) => {
      if (!level || !onEntityClick) return;

      const entitiesLayer = level.layerInstances.find(l => l.__identifier === 'Entities');
      if (!entitiesLayer?.entityInstances) return;

      for (const entity of entitiesLayer.entityInstances) {
        const dx = worldX - entity.px[0];
        const dy = worldY - entity.px[1];
        if (dx * dx + dy * dy < 32 * 32) {
          onEntityClick(entity);
          return;
        }
      }
    },
    [level, onEntityClick]
  );

  if (loading) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f0f23',
          color: '#4ecca3',
        }}
      >
        Loading level...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f0f23',
          color: '#ff6b6b',
        }}
      >
        {error}
      </div>
    );
  }

  if (!level) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f0f23',
          color: '#888',
        }}
      >
        Select a level to play
      </div>
    );
  }

  return (
    <PanZoomCanvas
      width={level.pxWid}
      height={level.pxHei}
      showGrid
      gridSize={TILE_SIZE}
      onRender={handleRender}
      onWorldClick={handleWorldClick}
      className={className}
      style={style}
    />
  );
}

// Helpers
function getTileColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${hash % 360}, 40%, 30%)`;
}

export default GameCanvas;
