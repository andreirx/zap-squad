import { useState, useRef, useCallback, useEffect } from 'react';
import { SpriteSheetEditor, type SpriteSheetEditorRef } from '../SpriteSheetEditor';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import type { Color, Tool } from '../types';
import {
  type TileAtlasSchema,
  type TileCell,
  buildTileSchema,
  SPRITE_SIZE,
  TILE_TRANSITIONS,
} from '../../types/atlas';

// ============================================================================
// Constants
// ============================================================================

const PATH_FADE_PIXELS = 4;

// Direction bit flags for path combinations (15 total)
const DIR_UP = 8;
const DIR_DOWN = 4;
const DIR_LEFT = 2;
const DIR_RIGHT = 1;

// All 15 path combinations (excluding 0 which is no connections)
const PATH_COMBINATIONS = [
  DIR_RIGHT,                          // 1: right only
  DIR_LEFT,                           // 2: left only
  DIR_LEFT | DIR_RIGHT,               // 3: horizontal
  DIR_DOWN,                           // 4: down only
  DIR_DOWN | DIR_RIGHT,               // 5: down-right corner
  DIR_DOWN | DIR_LEFT,                // 6: down-left corner
  DIR_DOWN | DIR_LEFT | DIR_RIGHT,    // 7: T down
  DIR_UP,                             // 8: up only
  DIR_UP | DIR_RIGHT,                 // 9: up-right corner
  DIR_UP | DIR_LEFT,                  // 10: up-left corner
  DIR_UP | DIR_LEFT | DIR_RIGHT,      // 11: T up
  DIR_UP | DIR_DOWN,                  // 12: vertical
  DIR_UP | DIR_DOWN | DIR_RIGHT,      // 13: T right
  DIR_UP | DIR_DOWN | DIR_LEFT,       // 14: T left
  DIR_UP | DIR_DOWN | DIR_LEFT | DIR_RIGHT, // 15: crossroads
];

// Default colors
const DEFAULT_TERRAIN_COLORS = ['#228b22', '#2e8b57', '#32cd32']; // Forest greens
const DEFAULT_PATH_COLORS = ['#8b4513', '#a0522d', '#cd853f']; // Browns
const DEFAULT_WATER_COLORS = ['#1e90ff', '#4169e1', '#6495ed']; // Blues

// ============================================================================
// Types
// ============================================================================

interface ManifestTile {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  variations: number;
  hasTransitions: boolean;
}

interface Manifest {
  version: number;
  spriteSize: number;
  maxFrames: number;
  tiles: Record<string, ManifestTile>;
}

type TileType = 'TILE' | 'PATH' | 'BRIDGE';
type TerrainType = 'LAND' | 'WATER';

interface TileConfig {
  tileType: TileType;
  terrainType: TerrainType;
  pathWidth: number;
  movementCost: number;
  terrainColors: string[];
  pathColors: string[];
  useRandomPathColors: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function TileSheetEditor() {
  // Tile list
  const [tiles, setTiles] = useState<ManifestTile[]>([]);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);

  // Current tile schema
  const [schema, setSchema] = useState<TileAtlasSchema | null>(null);
  const [atlasUrl, setAtlasUrl] = useState<string | null>(null);

  // Tile configuration
  const [tileConfig, setTileConfig] = useState<TileConfig>({
    tileType: 'TILE',
    terrainType: 'LAND',
    pathWidth: 56,
    movementCost: 1,
    terrainColors: [...DEFAULT_TERRAIN_COLORS],
    pathColors: [...DEFAULT_PATH_COLORS],
    useRandomPathColors: true,
  });

  // Selected cell for detailed editing
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [hoveredCell, setHoveredCell] = useState<TileCell | null>(null);

  // Drawing state
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 });
  const [zoom, setZoom] = useState(4);
  const [cellZoom, setCellZoom] = useState(4);
  const [showGrid, setShowGrid] = useState(true);
  const [recentColors, setRecentColors] = useState<Color[]>([]);

  // Refs
  const sheetRef = useRef<SpriteSheetEditorRef>(null);
  const cellCanvasRef = useRef<PixelCanvasRef>(null);
  const clipboardRef = useRef<ImageData | null>(null);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Load manifest on mount
  useEffect(() => {
    loadManifest();
  }, []);

  async function loadManifest() {
    setIsLoading(true);
    try {
      const storage = createStorage({ basePath: 'assets' });
      const manifestJson = await storage.readText('manifest.json');
      const manifest: Manifest = JSON.parse(manifestJson);
      setTiles(Object.values(manifest.tiles));
    } catch (e) {
      console.error('Failed to load manifest:', e);
      setError('Failed to load asset manifest');
    } finally {
      setIsLoading(false);
    }
  }

  // Select tile
  const selectTile = useCallback(async (tileId: string) => {
    const tile = tiles.find(t => t.id === tileId);
    if (!tile) return;

    setSelectedTileId(tileId);
    setSelectedCell(null);
    setHasUnsavedChanges(false);

    // Build schema from manifest data
    const tileSchema = buildTileSchema(
      tile.id,
      tile.name,
      tile.variations,
      tile.hasTransitions,
      tile.spriteSize
    );
    setSchema(tileSchema);

    // Detect tile type from variations
    const isPath = tile.variations === 15;
    setTileConfig(prev => ({
      ...prev,
      tileType: isPath ? 'PATH' : 'TILE',
    }));

    // Set atlas URL
    const storage = createStorage({ basePath: 'assets' });
    const url = storage.getReadUrl(tile.atlas);
    setAtlasUrl(url);
  }, [tiles]);

  // Handle cell selection
  const handleCellSelect = useCallback((cell: TileCell | null) => {
    if (!cell) return;
    setSelectedCell({ row: cell.row, col: cell.col });

    // Load cell data into detail canvas
    if (sheetRef.current && cellCanvasRef.current) {
      const cellData = sheetRef.current.getCellImageData(cell.row, cell.col);
      cellCanvasRef.current.setImageData(cellData);
    }
  }, []);

  // Handle cell hover
  const handleCellHover = useCallback((cell: unknown) => {
    setHoveredCell(cell as TileCell | null);
  }, []);

  // Sync cell canvas changes back to sheet
  const handleCellChange = useCallback(() => {
    if (!selectedCell || !cellCanvasRef.current || !sheetRef.current) return;
    const cellData = cellCanvasRef.current.getImageData();
    sheetRef.current.setCellImageData(selectedCell.row, selectedCell.col, cellData);
    setHasUnsavedChanges(true);
  }, [selectedCell]);

  // Handle sheet change
  const handleSheetChange = useCallback(() => {
    setHasUnsavedChanges(true);

    // Sync selected cell to detail canvas
    if (selectedCell && sheetRef.current && cellCanvasRef.current) {
      const cellData = sheetRef.current.getCellImageData(selectedCell.row, selectedCell.col);
      cellCanvasRef.current.setImageData(cellData);
    }
  }, [selectedCell]);

  // Save atlas
  const saveAtlas = useCallback(async () => {
    if (!selectedTileId || !sheetRef.current || !schema) return;

    setIsSaving(true);
    setError(null);

    try {
      const storage = createStorage({ basePath: 'assets' });

      // Get atlas as data URL then convert to blob
      const dataUrl = sheetRef.current.getAtlasDataUrl();
      const response = await fetch(dataUrl);
      const blob = await response.blob();

      // Save to assets folder
      const atlasPath = `tiles/${selectedTileId}.png`;
      await storage.writeBytes(atlasPath, await blob.arrayBuffer(), 'image/png');

      setHasUnsavedChanges(false);
      console.log(`Saved atlas: ${atlasPath}`);
    } catch (e) {
      setError(`Failed to save: ${e}`);
    } finally {
      setIsSaving(false);
    }
  }, [selectedTileId, schema]);

  // ============================================================================
  // Terrain Generation
  // ============================================================================

  // Fill cell with random terrain colors
  const fillCellWithTerrain = useCallback((row: number, col: number) => {
    if (!sheetRef.current) return;

    const colors = tileConfig.terrainType === 'WATER'
      ? DEFAULT_WATER_COLORS
      : tileConfig.terrainColors;

    const pixels = generateRandomTerrainPixels(colors);
    sheetRef.current.setCellImageData(row, col, pixels);
  }, [tileConfig]);

  // Fill current cell with terrain
  const handleFillCurrentCell = useCallback(() => {
    if (!selectedCell) return;
    fillCellWithTerrain(selectedCell.row, selectedCell.col);
    setHasUnsavedChanges(true);
  }, [selectedCell, fillCellWithTerrain]);

  // Fill all base tiles (row 0) with terrain
  const handleFillAllBaseTiles = useCallback(() => {
    if (!sheetRef.current || !schema) return;

    setIsGenerating(true);
    try {
      for (let col = 0; col < schema.columns; col++) {
        fillCellWithTerrain(0, col);
      }
      setHasUnsavedChanges(true);
    } finally {
      setIsGenerating(false);
    }
  }, [schema, fillCellWithTerrain]);

  // ============================================================================
  // Path Generation
  // ============================================================================

  // Generate a single path variation
  const generatePathVariation = useCallback((variationIndex: number): ImageData => {
    const { pathWidth, pathColors, useRandomPathColors, terrainType, terrainColors } = tileConfig;
    const size = SPRITE_SIZE;

    // Create pixel array
    const pixels = new ImageData(size, size);

    // Fill background with terrain
    const bgColors = terrainType === 'WATER' ? DEFAULT_WATER_COLORS : terrainColors;
    fillPixelsWithRandomColors(pixels.data, bgColors);

    // Get direction flags for this variation
    const dirFlags = PATH_COMBINATIONS[variationIndex];
    const hasUp = (dirFlags & DIR_UP) !== 0;
    const hasDown = (dirFlags & DIR_DOWN) !== 0;
    const hasLeft = (dirFlags & DIR_LEFT) !== 0;
    const hasRight = (dirFlags & DIR_RIGHT) !== 0;

    // Calculate path bounds
    const center = size / 2;
    const halfWidth = pathWidth / 2;

    // Draw path segments
    const drawPathSegment = (
      x0: number, y0: number,
      x1: number, y1: number,
      w: number
    ) => {
      const pathColorsParsed = pathColors.map(parseHexColor);

      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
          // Check if pixel is within path width
          let inPath = false;
          let distToEdge = 0;

          if (x0 === x1) {
            // Vertical segment
            const distFromCenter = Math.abs(x - center);
            inPath = distFromCenter <= w / 2;
            distToEdge = w / 2 - distFromCenter;
          } else if (y0 === y1) {
            // Horizontal segment
            const distFromCenter = Math.abs(y - center);
            inPath = distFromCenter <= w / 2;
            distToEdge = w / 2 - distFromCenter;
          }

          if (inPath && x >= 0 && x < size && y >= 0 && y < size) {
            const idx = (y * size + x) * 4;

            // Pick random path color
            const pathColor = useRandomPathColors
              ? pathColorsParsed[Math.floor(Math.random() * pathColorsParsed.length)]
              : pathColorsParsed[0];

            // Apply fade at edges
            if (distToEdge < PATH_FADE_PIXELS) {
              const fadeFactor = distToEdge / PATH_FADE_PIXELS;
              // Blend with existing pixel
              pixels.data[idx] = Math.round(pixels.data[idx] * (1 - fadeFactor) + pathColor.r * fadeFactor);
              pixels.data[idx + 1] = Math.round(pixels.data[idx + 1] * (1 - fadeFactor) + pathColor.g * fadeFactor);
              pixels.data[idx + 2] = Math.round(pixels.data[idx + 2] * (1 - fadeFactor) + pathColor.b * fadeFactor);
            } else {
              pixels.data[idx] = pathColor.r;
              pixels.data[idx + 1] = pathColor.g;
              pixels.data[idx + 2] = pathColor.b;
            }
            pixels.data[idx + 3] = 255;
          }
        }
      }
    };

    // Draw center junction
    const junctionHalf = pathWidth / 2;
    for (let y = center - junctionHalf; y <= center + junctionHalf; y++) {
      for (let x = center - junctionHalf; x <= center + junctionHalf; x++) {
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const idx = (Math.floor(y) * size + Math.floor(x)) * 4;
          const pathColorsParsed = pathColors.map(parseHexColor);
          const pathColor = useRandomPathColors
            ? pathColorsParsed[Math.floor(Math.random() * pathColorsParsed.length)]
            : pathColorsParsed[0];
          pixels.data[idx] = pathColor.r;
          pixels.data[idx + 1] = pathColor.g;
          pixels.data[idx + 2] = pathColor.b;
          pixels.data[idx + 3] = 255;
        }
      }
    }

    // Draw directional segments
    if (hasUp) drawPathSegment(center - halfWidth, 0, center + halfWidth, center - halfWidth, pathWidth);
    if (hasDown) drawPathSegment(center - halfWidth, center + halfWidth, center + halfWidth, size - 1, pathWidth);
    if (hasLeft) drawPathSegment(0, center - halfWidth, center - halfWidth, center + halfWidth, pathWidth);
    if (hasRight) drawPathSegment(center + halfWidth, center - halfWidth, size - 1, center + halfWidth, pathWidth);

    return pixels;
  }, [tileConfig]);

  // Generate all 15 path variations
  const handleGenerateAllPaths = useCallback(() => {
    if (!sheetRef.current || !schema) return;
    if (schema.columns < 15) {
      setError('Need 15 variations for PATH/BRIDGE generation');
      return;
    }

    setIsGenerating(true);
    try {
      for (let i = 0; i < 15; i++) {
        const pathPixels = generatePathVariation(i);
        sheetRef.current.setCellImageData(0, i, pathPixels);
      }
      setHasUnsavedChanges(true);
    } finally {
      setIsGenerating(false);
    }
  }, [schema, generatePathVariation]);

  // ============================================================================
  // UI Handlers
  // ============================================================================

  // Copy cell to all variations in this row
  const copyCellToRow = useCallback(() => {
    if (!selectedCell || !sheetRef.current || !schema) return;

    const srcData = sheetRef.current.getCellImageData(selectedCell.row, selectedCell.col);

    for (let col = 0; col < schema.columns; col++) {
      if (col !== selectedCell.col) {
        sheetRef.current.setCellImageData(selectedCell.row, col, srcData);
      }
    }
    setHasUnsavedChanges(true);
  }, [selectedCell, schema]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 's':
            e.preventDefault();
            saveAtlas();
            break;
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              sheetRef.current?.redo();
            } else {
              sheetRef.current?.undo();
            }
            break;
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'p':
          setTool('pencil');
          break;
        case 'e':
          setTool('eraser');
          break;
        case 'g':
          setTool('fill');
          break;
        case 'l':
          setTool('line');
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveAtlas]);

  // Add color to recent
  const addRecentColor = useCallback((c: Color) => {
    setRecentColors(prev => {
      const exists = prev.some(
        p => p.r === c.r && p.g === c.g && p.b === c.b && p.a === c.a
      );
      if (exists) return prev;
      return [c, ...prev.slice(0, 15)];
    });
  }, []);

  // Get cell label
  function getCellLabel(cell: TileCell | null): string {
    if (!cell) return '';
    if (cell.transition === null) {
      return `Base tile, variation ${cell.variation + 1}`;
    }
    return `Transition ${cell.transition}, variation ${cell.variation + 1}`;
  }

  // Update tile config
  const updateConfig = <K extends keyof TileConfig>(key: K, value: TileConfig[K]) => {
    setTileConfig(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar - Tile list */}
      <div
        style={{
          width: 220,
          background: '#16213e',
          padding: '1rem',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ color: '#4ecca3', margin: '0 0 1rem 0', fontSize: '1rem' }}>
          Tile Sheets
        </h3>

        <button
          onClick={loadManifest}
          disabled={isLoading}
          style={{
            width: '100%',
            padding: '0.5rem',
            background: '#0f0f23',
            color: '#888',
            border: '1px solid #333',
            borderRadius: '4px',
            cursor: 'pointer',
            marginBottom: '0.5rem',
            fontSize: '0.75rem',
          }}
        >
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>

        {tiles.map(tile => (
          <div
            key={tile.id}
            onClick={() => selectTile(tile.id)}
            style={{
              padding: '0.5rem',
              background: tile.id === selectedTileId ? '#4ecca3' : '#0f0f23',
              color: tile.id === selectedTileId ? '#1a1a2e' : '#ccc',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '0.25rem',
            }}
          >
            <div style={{ fontWeight: 'bold', fontSize: '0.875rem' }}>{tile.name}</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
              {tile.variations} vars{tile.variations === 15 ? ' (PATH)' : ''}
            </div>
          </div>
        ))}
      </div>

      {/* Main editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <div
          style={{
            padding: '0.5rem 1rem',
            background: '#16213e',
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
          }}
        >
          <span style={{ color: '#4ecca3', fontWeight: 'bold' }}>
            {selectedTileId ? `Editing: ${selectedTileId}` : 'Select a tile'}
          </span>

          {hasUnsavedChanges && (
            <span style={{ color: '#ffd93d', fontSize: '0.875rem' }}>
              (unsaved changes)
            </span>
          )}

          <div style={{ flex: 1 }} />

          <button
            onClick={saveAtlas}
            disabled={isSaving || !selectedTileId || !hasUnsavedChanges}
            style={{
              padding: '0.5rem 1rem',
              background: isSaving || !hasUnsavedChanges ? '#555' : '#4ecca3',
              color: isSaving || !hasUnsavedChanges ? '#999' : '#1a1a2e',
              border: 'none',
              borderRadius: '4px',
              cursor: isSaving || !hasUnsavedChanges ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
            }}
          >
            {isSaving ? 'Saving...' : 'Save (Ctrl+S)'}
          </button>

          {error && (
            <span style={{ color: '#ff6b6b', fontSize: '0.875rem' }}>{error}</span>
          )}
        </div>

        {/* Toolbar */}
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          zoom={zoom}
          onZoomChange={setZoom}
          showGrid={showGrid}
          onShowGridChange={setShowGrid}
          onUndo={() => sheetRef.current?.undo()}
          onRedo={() => sheetRef.current?.redo()}
          canUndo={sheetRef.current?.canUndo() ?? false}
          canRedo={sheetRef.current?.canRedo() ?? false}
          onCopy={() => {
            if (selectedCell && sheetRef.current) {
              clipboardRef.current = sheetRef.current.getCellImageData(
                selectedCell.row,
                selectedCell.col
              );
            }
          }}
          onPaste={() => {
            if (selectedCell && sheetRef.current && clipboardRef.current) {
              sheetRef.current.setCellImageData(
                selectedCell.row,
                selectedCell.col,
                clipboardRef.current
              );
              setHasUnsavedChanges(true);
            }
          }}
        />

        {/* Content area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Sprite sheet view */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '1rem',
              background: '#0f0f23',
            }}
          >
            {schema && atlasUrl ? (
              <>
                {/* Cell info */}
                <div style={{ marginBottom: '0.5rem', color: '#888', fontSize: '0.875rem' }}>
                  {hoveredCell ? (
                    <span style={{ color: '#4ecca3' }}>{getCellLabel(hoveredCell)}</span>
                  ) : (
                    'Hover over a cell to see info'
                  )}
                </div>

                {/* Sheet editor */}
                <SpriteSheetEditor
                  ref={sheetRef}
                  schema={schema}
                  atlasUrl={atlasUrl}
                  zoom={zoom}
                  tool={tool}
                  color={color}
                  showGrid={showGrid}
                  selectedCell={selectedCell}
                  onCellSelect={(cell) => handleCellSelect(cell as TileCell)}
                  onCellHover={handleCellHover}
                  onChange={handleSheetChange}
                />
              </>
            ) : (
              <div style={{ color: '#666', textAlign: 'center', paddingTop: '4rem' }}>
                Select a tile from the list to edit its sprite sheet
              </div>
            )}
          </div>

          {/* Right panel - Controls and detail editor */}
          <div
            style={{
              width: 380,
              background: '#16213e',
              padding: '0.5rem',
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
            }}
          >
            {/* Generation Controls */}
            <div style={{ marginBottom: '1rem', padding: '0.5rem', background: '#0f0f23', borderRadius: '4px' }}>
              <div style={{ color: '#4ecca3', fontWeight: 'bold', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                Generation Controls
              </div>

              {/* Tile Type */}
              <div style={{ marginBottom: '0.5rem' }}>
                <label style={{ color: '#888', fontSize: '0.75rem', display: 'block', marginBottom: '0.25rem' }}>
                  Tile Type
                </label>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {(['TILE', 'PATH', 'BRIDGE'] as TileType[]).map(type => (
                    <button
                      key={type}
                      onClick={() => updateConfig('tileType', type)}
                      style={{
                        flex: 1,
                        padding: '0.25rem',
                        border: 'none',
                        borderRadius: '4px',
                        background: tileConfig.tileType === type ? '#4ecca3' : '#16213e',
                        color: tileConfig.tileType === type ? '#1a1a2e' : '#ccc',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              {/* Terrain Type */}
              <div style={{ marginBottom: '0.5rem' }}>
                <label style={{ color: '#888', fontSize: '0.75rem', display: 'block', marginBottom: '0.25rem' }}>
                  Terrain Type
                </label>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {(['LAND', 'WATER'] as TerrainType[]).map(type => (
                    <button
                      key={type}
                      onClick={() => updateConfig('terrainType', type)}
                      style={{
                        flex: 1,
                        padding: '0.25rem',
                        border: 'none',
                        borderRadius: '4px',
                        background: tileConfig.terrainType === type ? (type === 'WATER' ? '#4169e1' : '#4ecca3') : '#16213e',
                        color: tileConfig.terrainType === type ? '#fff' : '#ccc',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              {/* Path Width */}
              {(tileConfig.tileType === 'PATH' || tileConfig.tileType === 'BRIDGE') && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <label style={{ color: '#888', fontSize: '0.75rem', display: 'block', marginBottom: '0.25rem' }}>
                    Path Width: {tileConfig.pathWidth}px
                  </label>
                  <input
                    type="range"
                    min="16"
                    max="112"
                    value={tileConfig.pathWidth}
                    onChange={(e) => updateConfig('pathWidth', parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>
              )}

              {/* Movement Cost / Difficulty */}
              <div style={{ marginBottom: '0.5rem' }}>
                <label style={{ color: '#888', fontSize: '0.75rem', display: 'block', marginBottom: '0.25rem' }}>
                  Movement Cost (1=easy, 3+=difficult, 0=impassable): {tileConfig.movementCost}
                </label>
                <input
                  type="range"
                  min="0"
                  max="10"
                  value={tileConfig.movementCost}
                  onChange={(e) => updateConfig('movementCost', parseInt(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>

              {/* Terrain Colors */}
              <div style={{ marginBottom: '0.5rem' }}>
                <label style={{ color: '#888', fontSize: '0.75rem', display: 'block', marginBottom: '0.25rem' }}>
                  Terrain Colors (3 random)
                </label>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {tileConfig.terrainColors.map((c, i) => (
                    <input
                      key={i}
                      type="color"
                      value={c}
                      onChange={(e) => {
                        const newColors = [...tileConfig.terrainColors];
                        newColors[i] = e.target.value;
                        updateConfig('terrainColors', newColors);
                      }}
                      style={{ flex: 1, height: 24, border: 'none', cursor: 'pointer' }}
                    />
                  ))}
                </div>
              </div>

              {/* Path Colors */}
              {(tileConfig.tileType === 'PATH' || tileConfig.tileType === 'BRIDGE') && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <label style={{ color: '#888', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span>Path Colors</span>
                    <label style={{ fontSize: '0.625rem', color: '#666' }}>
                      <input
                        type="checkbox"
                        checked={tileConfig.useRandomPathColors}
                        onChange={(e) => updateConfig('useRandomPathColors', e.target.checked)}
                      />
                      {' '}Random
                    </label>
                  </label>
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    {tileConfig.pathColors.map((c, i) => (
                      <input
                        key={i}
                        type="color"
                        value={c}
                        onChange={(e) => {
                          const newColors = [...tileConfig.pathColors];
                          newColors[i] = e.target.value;
                          updateConfig('pathColors', newColors);
                        }}
                        style={{ flex: 1, height: 24, border: 'none', cursor: 'pointer' }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Generation Buttons */}
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                <button
                  onClick={handleFillCurrentCell}
                  disabled={!selectedCell || isGenerating}
                  style={{
                    padding: '0.375rem 0.5rem',
                    border: 'none',
                    borderRadius: '4px',
                    background: selectedCell ? '#4ecca3' : '#555',
                    color: selectedCell ? '#1a1a2e' : '#999',
                    cursor: selectedCell ? 'pointer' : 'not-allowed',
                    fontSize: '0.75rem',
                  }}
                >
                  Fill Cell
                </button>

                <button
                  onClick={handleFillAllBaseTiles}
                  disabled={isGenerating}
                  style={{
                    padding: '0.375rem 0.5rem',
                    border: 'none',
                    borderRadius: '4px',
                    background: '#4ecca3',
                    color: '#1a1a2e',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                  }}
                >
                  Fill All Base
                </button>

                {(tileConfig.tileType === 'PATH' || tileConfig.tileType === 'BRIDGE') && (
                  <button
                    onClick={handleGenerateAllPaths}
                    disabled={isGenerating || !schema || schema.columns < 15}
                    style={{
                      padding: '0.375rem 0.5rem',
                      border: 'none',
                      borderRadius: '4px',
                      background: '#ffd93d',
                      color: '#1a1a2e',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                    }}
                  >
                    {isGenerating ? 'Generating...' : 'Generate All 15 Paths'}
                  </button>
                )}
              </div>
            </div>

            {/* Cell detail canvas */}
            <div style={{ marginBottom: '0.5rem' }}>
              <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                Cell Detail (click cell to edit)
              </div>

              {selectedCell && schema ? (
                <div style={{ background: '#0f0f23', padding: '0.5rem', borderRadius: '4px' }}>
                  <div style={{ marginBottom: '0.5rem', color: '#4ecca3', fontSize: '0.875rem' }}>
                    {schema.rows[selectedCell.row]?.type === 'base'
                      ? `Base - Var ${selectedCell.col + 1}`
                      : `Trans ${(schema.rows[selectedCell.row] as { transition?: string }).transition} - Var ${selectedCell.col + 1}`
                    }
                  </div>

                  <PixelCanvas
                    ref={cellCanvasRef}
                    width={SPRITE_SIZE}
                    height={SPRITE_SIZE}
                    zoom={cellZoom}
                    tool={tool}
                    color={color}
                    showGrid={showGrid}
                    onChange={handleCellChange}
                    onColorPick={setColor}
                  />

                  <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    <button
                      onClick={copyCellToRow}
                      style={{
                        padding: '0.25rem 0.5rem',
                        border: '1px solid #333',
                        borderRadius: '4px',
                        background: '#0f0f23',
                        color: '#ccc',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      Copy to all variations
                    </button>
                  </div>

                  {/* Zoom control for cell */}
                  <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#666', fontSize: '0.75rem' }}>Zoom:</span>
                    <input
                      type="range"
                      min="1"
                      max="8"
                      value={cellZoom}
                      onChange={(e) => setCellZoom(parseInt(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span style={{ color: '#888', fontSize: '0.75rem' }}>{cellZoom}x</span>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: '#0f0f23',
                    padding: '2rem',
                    borderRadius: '4px',
                    color: '#666',
                    textAlign: 'center',
                    fontSize: '0.875rem',
                  }}
                >
                  Click a cell in the sprite sheet to edit it in detail
                </div>
              )}
            </div>

            {/* Transition reference */}
            <div style={{ marginBottom: '0.5rem', color: '#888', fontSize: '0.75rem' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Transitions:</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                {TILE_TRANSITIONS.map((t, i) => (
                  <span key={t} style={{
                    background: '#0f0f23',
                    padding: '0.125rem 0.25rem',
                    borderRadius: '2px',
                    fontSize: '0.625rem',
                  }}>
                    R{i + 1}: {t}
                  </span>
                ))}
              </div>
            </div>

            {/* Color picker */}
            <ColorPicker
              color={color}
              onChange={setColor}
              recentColors={recentColors}
              onAddRecent={addRecentColor}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 0, g: 0, b: 0 };
}

function generateRandomTerrainPixels(colors: string[]): ImageData {
  const size = SPRITE_SIZE;
  const pixels = new ImageData(size, size);
  fillPixelsWithRandomColors(pixels.data, colors);
  return pixels;
}

function fillPixelsWithRandomColors(data: Uint8ClampedArray, colors: string[]) {
  const parsedColors = colors.map(parseHexColor);

  for (let i = 0; i < data.length; i += 4) {
    const color = parsedColors[Math.floor(Math.random() * parsedColors.length)];
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
    data[i + 3] = 255;
  }
}

export default TileSheetEditor;
