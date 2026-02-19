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

  // Selected cell for detailed editing
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [hoveredCell, setHoveredCell] = useState<TileCell | null>(null);

  // Drawing state
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 });
  const [zoom, setZoom] = useState(4);
  const [cellZoom, setCellZoom] = useState(8);
  const [showGrid, setShowGrid] = useState(true);
  const [recentColors, setRecentColors] = useState<Color[]>([]);

  // Refs
  const sheetRef = useRef<SpriteSheetEditorRef>(null);
  const cellCanvasRef = useRef<PixelCanvasRef>(null);
  const clipboardRef = useRef<ImageData | null>(null);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
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
              {tile.variations} vars, {tile.hasTransitions ? '+ transitions' : 'no trans'}
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

          {/* Right panel - Cell detail editor */}
          <div
            style={{
              width: 340,
              background: '#16213e',
              padding: '0.5rem',
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
            }}
          >
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
                      min="2"
                      max="16"
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

export default TileSheetEditor;
