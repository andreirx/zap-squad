import { useCallback, useEffect, useState, useRef } from 'react';
import { PanZoomCanvas } from './PanZoomCanvas';

// ============================================================================
// Types - Match manifest.json structure
// ============================================================================

interface AnimationInfo {
  row: number;
  frames: number;
  loop: boolean;
}

interface CharacterAtlasInfo {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  animations: Record<string, AnimationInfo>;
}

interface TileAtlasInfo {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  variations: number;
  hasTransitions: boolean;
}

interface WeaponAtlasInfo {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  animations: Record<string, AnimationInfo>;
  anchorX: number;
  anchorY: number;
}

interface AssetManifest {
  version: number;
  spriteSize: number;
  maxFrames: number;
  characters: Record<string, CharacterAtlasInfo>;
  tiles: Record<string, TileAtlasInfo>;
  weapons: Record<string, WeaponAtlasInfo>;
}

interface TileInstance {
  x: number;
  y: number;
  tileId: string;
  variation: number;
}

interface EntityInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  bodyDefId: string;
  animationState: string;
  direction: string;
  frame: number;
}

interface LevelData {
  name: string;
  width: number;
  height: number;
  tileSize: number;
  tiles: TileInstance[];
  entities: EntityInstance[];
}

interface GameCanvasProps {
  levelId?: string;
  onEntityClick?: (entity: EntityInstance) => void;
  className?: string;
  style?: React.CSSProperties;
}

// ============================================================================
// Atlas Cache
// ============================================================================

const atlasCache = new Map<string, HTMLImageElement>();

async function loadAtlas(url: string): Promise<HTMLImageElement> {
  if (atlasCache.has(url)) {
    return atlasCache.get(url)!;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      atlasCache.set(url, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ============================================================================
// Component
// ============================================================================

export function GameCanvas({
  levelId,
  onEntityClick,
  className,
  style,
}: GameCanvasProps) {
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [level, setLevel] = useState<LevelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded atlases (id -> image)
  const tileAtlases = useRef<Map<string, HTMLImageElement>>(new Map());
  const characterAtlases = useRef<Map<string, HTMLImageElement>>(new Map());

  // Animation state
  const [animationTick, setAnimationTick] = useState(0);

  // Animation timer
  useEffect(() => {
    const interval = setInterval(() => {
      setAnimationTick((t) => t + 1);
    }, 100); // 10 FPS animation
    return () => clearInterval(interval);
  }, []);

  // Load manifest on mount
  useEffect(() => {
    async function loadManifest() {
      try {
        const response = await fetch('/assets/manifest.json');
        if (!response.ok) {
          throw new Error(`Failed to load manifest: ${response.status}`);
        }
        const data = await response.json();
        setManifest(data);
      } catch (e) {
        console.error('Failed to load asset manifest:', e);
        setError('Failed to load asset manifest');
      }
    }
    loadManifest();
  }, []);

  // Load level
  useEffect(() => {
    if (!levelId || !manifest) {
      setLevel(null);
      return;
    }

    async function loadLevel() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/mods/levels/${levelId}.json`);
        if (!response.ok) {
          throw new Error(`Failed to load level: ${response.status}`);
        }
        const data = await response.json();

        // Parse LDtk-compatible format
        const ldtkLevel = data.levels?.[0];
        if (!ldtkLevel) {
          throw new Error('No level data found');
        }

        const tilesLayer = ldtkLevel.layerInstances?.find(
          (l: { __identifier: string }) => l.__identifier === 'Tiles'
        );
        const entitiesLayer = ldtkLevel.layerInstances?.find(
          (l: { __identifier: string }) => l.__identifier === 'Entities'
        );

        const tileSize = tilesLayer?.__gridSize || manifest!.spriteSize;

        const tiles: TileInstance[] = (tilesLayer?.gridTiles || []).map(
          (t: { px: number[]; src: string; t: number }) => ({
            x: t.px[0],
            y: t.px[1],
            tileId: t.src,
            variation: t.t,
          })
        );

        const entities: EntityInstance[] = (
          entitiesLayer?.entityInstances || []
        ).map(
          (
            e: {
              __identifier: string;
              px: number[];
              fieldInstances?: Array<{
                __identifier: string;
                __value: unknown;
              }>;
            },
            i: number
          ) => {
            const bodyDefId =
              (e.fieldInstances?.find((f) => f.__identifier === 'body_def_id')
                ?.__value as string) || 'unknown';
            return {
              id: `entity_${i}`,
              type: e.__identifier,
              x: e.px[0],
              y: e.px[1],
              bodyDefId,
              animationState: 'idle_south',
              direction: 'south',
              frame: 0,
            };
          }
        );

        setLevel({
          name: ldtkLevel.identifier,
          width: ldtkLevel.pxWid,
          height: ldtkLevel.pxHei,
          tileSize,
          tiles,
          entities,
        });

        // Preload atlases
        await preloadAtlases(tiles, entities);
      } catch (e) {
        setError(`Failed to load level: ${e}`);
      } finally {
        setLoading(false);
      }
    }

    loadLevel();
  }, [levelId, manifest]);

  // Preload required atlases
  async function preloadAtlases(
    tiles: TileInstance[],
    entities: EntityInstance[]
  ) {
    if (!manifest) return;

    // Load tile atlases
    const tileIds = [...new Set(tiles.map((t) => t.tileId))];
    for (const tileId of tileIds) {
      const tileInfo = manifest.tiles[tileId];
      if (tileInfo && !tileAtlases.current.has(tileId)) {
        try {
          const img = await loadAtlas(`/assets/${tileInfo.atlas}`);
          tileAtlases.current.set(tileId, img);
        } catch (e) {
          console.warn(`Failed to load tile atlas: ${tileId}`, e);
        }
      }
    }

    // Load character atlases
    const charIds = [...new Set(entities.map((e) => e.bodyDefId))];
    for (const charId of charIds) {
      const charInfo = manifest.characters[charId];
      if (charInfo && !characterAtlases.current.has(charId)) {
        try {
          const img = await loadAtlas(`/assets/${charInfo.atlas}`);
          characterAtlases.current.set(charId, img);
        } catch (e) {
          console.warn(`Failed to load character atlas: ${charId}`, e);
        }
      }
    }
  }

  // Render callback
  const handleRender = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!level || !manifest) return;

      const spriteSize = manifest.spriteSize;

      // Draw tiles
      for (const tile of level.tiles) {
        const tileInfo = manifest.tiles[tile.tileId];
        const atlas = tileAtlases.current.get(tile.tileId);

        if (tileInfo && atlas) {
          // Use variation modulo available variations
          const variation = tile.variation % tileInfo.variations;
          const srcX = variation * spriteSize;
          const srcY = 0; // Base tiles are on row 0

          ctx.drawImage(
            atlas,
            srcX,
            srcY,
            spriteSize,
            spriteSize,
            tile.x,
            tile.y,
            level.tileSize,
            level.tileSize
          );
        } else {
          // Fallback: colored rectangle
          ctx.fillStyle = getTileColor(tile.tileId);
          ctx.fillRect(tile.x, tile.y, level.tileSize, level.tileSize);
        }
      }

      // Draw entities
      for (const entity of level.entities) {
        const charInfo = manifest.characters[entity.bodyDefId];
        const atlas = characterAtlases.current.get(entity.bodyDefId);

        if (charInfo && atlas) {
          // Find animation
          const animKey = `${entity.animationState}`;
          const anim = charInfo.animations[animKey];

          if (anim) {
            // Calculate frame based on animation tick
            const frame = anim.loop
              ? animationTick % anim.frames
              : Math.min(entity.frame, anim.frames - 1);

            // Direct row lookup (no visual states)
            const srcX = frame * spriteSize;
            const srcY = anim.row * spriteSize;

            ctx.drawImage(
              atlas,
              srcX,
              srcY,
              spriteSize,
              spriteSize,
              entity.x - level.tileSize / 2,
              entity.y - level.tileSize / 2,
              level.tileSize,
              level.tileSize
            );
          }
        } else {
          // Fallback: circle
          ctx.fillStyle = getEntityColor(entity.type);
          ctx.beginPath();
          ctx.arc(entity.x, entity.y, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Draw entity label
        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(entity.bodyDefId, entity.x, entity.y + 24);
      }
    },
    [level, manifest, animationTick]
  );

  // Handle entity click
  const handleWorldClick = useCallback(
    (worldX: number, worldY: number) => {
      if (!level || !onEntityClick) return;

      for (const entity of level.entities) {
        const dx = worldX - entity.x;
        const dy = worldY - entity.y;
        if (dx * dx + dy * dy < 16 * 16) {
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
      width={level.width}
      height={level.height}
      showGrid
      gridSize={level.tileSize}
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

function getEntityColor(type: string): string {
  const colors: Record<string, string> = {
    Character: '#4ecca3',
    Player: '#4ecca3',
    Enemy: '#ff6b6b',
    Item: '#ffd93d',
    Trigger: '#6bcbff',
  };
  return colors[type] || '#888';
}

export default GameCanvas;
