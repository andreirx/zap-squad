import { useState, useCallback, useEffect } from 'react';
import { PanZoomCanvas } from '../../components/PanZoomCanvas';
import { createStorage } from '../../storage';

interface TileData {
  id: string;
  x: number;
  y: number;
}

interface EntityData {
  id: string;
  type: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

interface LevelData {
  name: string;
  width: number;
  height: number;
  tileSize: number;
  tiles: TileData[];
  entities: EntityData[];
}

type Tool = 'select' | 'tile' | 'entity' | 'eraser';

/**
 * Map Editor using LDtk-compatible data format
 *
 * Features:
 * - Infinite canvas with pan/zoom
 * - Tile painting
 * - Entity placement
 * - Grid snapping
 * - Export to LDtk-compatible JSON
 */
export function MapEditor() {
  // Level state
  const [level, setLevel] = useState<LevelData>({
    name: 'New Level',
    width: 800,
    height: 600,
    tileSize: 32,
    tiles: [],
    entities: [],
  });

  // Editor state
  const [tool, setTool] = useState<Tool>('tile');
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [selectedEntityType, setSelectedEntityType] = useState<string>('Player');
  const [showGrid, setShowGrid] = useState(true);
  const [cursorWorld, setCursorWorld] = useState({ x: 0, y: 0 });

  // Available tiles (loaded from storage)
  const [availableTiles, setAvailableTiles] = useState<string[]>([]);
  const [availableEntities] = useState<string[]>(['Player', 'Enemy', 'Item', 'Trigger']);

  // Load available tiles
  useEffect(() => {
    async function loadTiles() {
      try {
        const storage = createStorage();
        const files = await storage.list('tiles');
        const ids = [...new Set(
          files
            .filter(f => f.includes('/definition.json'))
            .map(f => f.split('/')[1])
        )];
        setAvailableTiles(ids);
        if (ids.length > 0 && !selectedTileId) {
          setSelectedTileId(ids[0]);
        }
      } catch (e) {
        console.error('Failed to load tiles:', e);
      }
    }
    loadTiles();
  }, [selectedTileId]);

  // Handle world mouse move
  const handleWorldMouseMove = useCallback((worldX: number, worldY: number) => {
    setCursorWorld({ x: worldX, y: worldY });
  }, []);

  // Snap to grid
  const snapToGrid = useCallback((x: number, y: number) => {
    const gridX = Math.floor(x / level.tileSize) * level.tileSize;
    const gridY = Math.floor(y / level.tileSize) * level.tileSize;
    return { x: gridX, y: gridY };
  }, [level.tileSize]);

  // Handle world click
  const handleWorldClick = useCallback((worldX: number, worldY: number, button: number) => {
    if (button !== 0) return; // Left click only

    const snapped = snapToGrid(worldX, worldY);

    if (tool === 'tile' && selectedTileId) {
      // Check bounds
      if (snapped.x < 0 || snapped.x >= level.width || snapped.y < 0 || snapped.y >= level.height) {
        return;
      }

      // Add or replace tile
      setLevel(prev => {
        const existingIdx = prev.tiles.findIndex(
          t => t.x === snapped.x && t.y === snapped.y
        );

        const newTile: TileData = {
          id: selectedTileId,
          x: snapped.x,
          y: snapped.y,
        };

        if (existingIdx >= 0) {
          const newTiles = [...prev.tiles];
          newTiles[existingIdx] = newTile;
          return { ...prev, tiles: newTiles };
        } else {
          return { ...prev, tiles: [...prev.tiles, newTile] };
        }
      });
    } else if (tool === 'entity') {
      // Add entity at click position
      const newEntity: EntityData = {
        id: `entity_${Date.now()}`,
        type: selectedEntityType,
        x: worldX,
        y: worldY,
        properties: {},
      };
      setLevel(prev => ({ ...prev, entities: [...prev.entities, newEntity] }));
    } else if (tool === 'eraser') {
      // Remove tile at position
      setLevel(prev => ({
        ...prev,
        tiles: prev.tiles.filter(t => t.x !== snapped.x || t.y !== snapped.y),
      }));
    }
  }, [tool, selectedTileId, selectedEntityType, level.width, level.height, snapToGrid]);

  // Render callback
  const handleRender = useCallback((ctx: CanvasRenderingContext2D, _transform: { scale: number }) => {
    // Draw tiles
    for (const tile of level.tiles) {
      // For now, draw colored rectangles. In production, draw actual tile sprites.
      ctx.fillStyle = getTileColor(tile.id);
      ctx.fillRect(tile.x, tile.y, level.tileSize, level.tileSize);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tile.x, tile.y, level.tileSize, level.tileSize);
    }

    // Draw entities
    for (const entity of level.entities) {
      ctx.fillStyle = getEntityColor(entity.type);
      ctx.beginPath();
      ctx.arc(entity.x, entity.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(entity.type, entity.x, entity.y + 24);
    }

    // Draw cursor preview
    if (tool === 'tile' && selectedTileId) {
      const snapped = snapToGrid(cursorWorld.x, cursorWorld.y);
      if (snapped.x >= 0 && snapped.x < level.width && snapped.y >= 0 && snapped.y < level.height) {
        ctx.fillStyle = 'rgba(78, 204, 163, 0.3)';
        ctx.fillRect(snapped.x, snapped.y, level.tileSize, level.tileSize);
        ctx.strokeStyle = '#4ecca3';
        ctx.lineWidth = 2;
        ctx.strokeRect(snapped.x, snapped.y, level.tileSize, level.tileSize);
      }
    } else if (tool === 'entity') {
      ctx.fillStyle = 'rgba(78, 204, 163, 0.5)';
      ctx.beginPath();
      ctx.arc(cursorWorld.x, cursorWorld.y, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [level, tool, selectedTileId, cursorWorld, snapToGrid]);

  // Export to LDtk-compatible JSON
  const exportLevel = useCallback(() => {
    const ldtkLevel = {
      identifier: level.name.replace(/\s+/g, '_'),
      pxWid: level.width,
      pxHei: level.height,
      layerInstances: [
        {
          __identifier: 'Tiles',
          __type: 'Tiles',
          __gridSize: level.tileSize,
          gridTiles: level.tiles.map(t => ({
            px: [t.x, t.y],
            t: availableTiles.indexOf(t.id),
          })),
        },
        {
          __identifier: 'Entities',
          __type: 'Entities',
          __gridSize: level.tileSize,
          entityInstances: level.entities.map(e => ({
            __identifier: e.type,
            px: [Math.round(e.x), Math.round(e.y)],
            fieldInstances: Object.entries(e.properties).map(([k, v]) => ({
              __identifier: k,
              __value: v,
            })),
          })),
        },
      ],
    };

    const json = JSON.stringify({ levels: [ldtkLevel] }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${level.name.replace(/\s+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [level, availableTiles]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar - Tools */}
      <div style={{
        width: 200,
        background: '#16213e',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}>
        <h3 style={{ color: '#4ecca3', margin: 0 }}>Tools</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {(['select', 'tile', 'entity', 'eraser'] as Tool[]).map(t => (
            <button
              key={t}
              onClick={() => setTool(t)}
              style={{
                padding: '0.5rem',
                background: tool === t ? '#4ecca3' : '#0f0f23',
                color: tool === t ? '#1a1a2e' : '#ccc',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {tool === 'tile' && (
          <>
            <h4 style={{ color: '#888', margin: 0 }}>Tiles</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {availableTiles.map(id => (
                <button
                  key={id}
                  onClick={() => setSelectedTileId(id)}
                  style={{
                    width: 40,
                    height: 40,
                    background: selectedTileId === id ? '#4ecca3' : getTileColor(id),
                    border: selectedTileId === id ? '2px solid #fff' : '1px solid #333',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                  title={id}
                />
              ))}
              {availableTiles.length === 0 && (
                <span style={{ color: '#666', fontSize: '0.75rem' }}>
                  No tiles. Create some in Tile Editor.
                </span>
              )}
            </div>
          </>
        )}

        {tool === 'entity' && (
          <>
            <h4 style={{ color: '#888', margin: 0 }}>Entity Type</h4>
            <select
              value={selectedEntityType}
              onChange={e => setSelectedEntityType(e.target.value)}
              style={{
                padding: '0.5rem',
                background: '#0f0f23',
                color: '#ccc',
                border: '1px solid #333',
                borderRadius: '4px',
              }}
            >
              {availableEntities.map(e => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </>
        )}

        <div style={{ flex: 1 }} />

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showGrid}
            onChange={e => setShowGrid(e.target.checked)}
          />
          <span style={{ color: '#888' }}>Show Grid</span>
        </label>

        <button
          onClick={exportLevel}
          style={{
            padding: '0.75rem',
            background: '#4ecca3',
            color: '#1a1a2e',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          Export Level
        </button>
      </div>

      {/* Main canvas area */}
      <div style={{ flex: 1, position: 'relative' }}>
        <PanZoomCanvas
          width={level.width}
          height={level.height}
          showGrid={showGrid}
          gridSize={level.tileSize}
          onRender={handleRender}
          onWorldMouseMove={handleWorldMouseMove}
          onWorldClick={handleWorldClick}
          style={{ width: '100%', height: '100%' }}
        />

        {/* Status bar */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '0.5rem 1rem',
          background: 'rgba(0, 0, 0, 0.7)',
          color: '#888',
          fontSize: '0.75rem',
          display: 'flex',
          gap: '2rem',
        }}>
          <span>World: ({Math.round(cursorWorld.x)}, {Math.round(cursorWorld.y)})</span>
          <span>Grid: ({Math.floor(cursorWorld.x / level.tileSize)}, {Math.floor(cursorWorld.y / level.tileSize)})</span>
          <span>Tiles: {level.tiles.length}</span>
          <span>Entities: {level.entities.length}</span>
          <span style={{ color: '#666' }}>Scroll to zoom, Middle-click or Space+drag to pan</span>
        </div>
      </div>

      {/* Right sidebar - Level properties */}
      <div style={{
        width: 200,
        background: '#16213e',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}>
        <h3 style={{ color: '#4ecca3', margin: 0 }}>Level</h3>

        <label style={{ color: '#888', fontSize: '0.75rem' }}>Name</label>
        <input
          type="text"
          value={level.name}
          onChange={e => setLevel(prev => ({ ...prev, name: e.target.value }))}
          style={{
            padding: '0.5rem',
            background: '#0f0f23',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: '4px',
          }}
        />

        <label style={{ color: '#888', fontSize: '0.75rem' }}>Width</label>
        <input
          type="number"
          value={level.width}
          onChange={e => setLevel(prev => ({ ...prev, width: parseInt(e.target.value) || 800 }))}
          style={{
            padding: '0.5rem',
            background: '#0f0f23',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: '4px',
          }}
        />

        <label style={{ color: '#888', fontSize: '0.75rem' }}>Height</label>
        <input
          type="number"
          value={level.height}
          onChange={e => setLevel(prev => ({ ...prev, height: parseInt(e.target.value) || 600 }))}
          style={{
            padding: '0.5rem',
            background: '#0f0f23',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: '4px',
          }}
        />

        <label style={{ color: '#888', fontSize: '0.75rem' }}>Tile Size</label>
        <input
          type="number"
          value={level.tileSize}
          onChange={e => setLevel(prev => ({ ...prev, tileSize: parseInt(e.target.value) || 32 }))}
          style={{
            padding: '0.5rem',
            background: '#0f0f23',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: '4px',
          }}
        />
      </div>
    </div>
  );
}

// Helper functions for placeholder colors
function getTileColor(id: string): string {
  // Generate consistent color from ID
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = hash % 360;
  return `hsl(${h}, 60%, 40%)`;
}

function getEntityColor(type: string): string {
  const colors: Record<string, string> = {
    Player: '#4ecca3',
    Enemy: '#ff6b6b',
    Item: '#ffd93d',
    Trigger: '#6bcbff',
  };
  return colors[type] || '#888';
}

export default MapEditor;
