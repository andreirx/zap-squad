import { useState, useRef, useCallback, useEffect } from 'react';
import { SpriteSheetEditor, type SpriteSheetEditorRef } from '../SpriteSheetEditor';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import type { Color, Tool } from '../types';
import {
  type WeaponAtlasSchema,
  type WeaponCell,
  buildWeaponSchema,
  SPRITE_SIZE,
} from '../../types/atlas';

// ============================================================================
// Types
// ============================================================================

interface ManifestWeapon {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  animations: Record<string, { row: number; frames: number; loop: boolean }>;
  anchorX: number;
  anchorY: number;
}

interface Manifest {
  version: number;
  spriteSize: number;
  maxFrames: number;
  weapons: Record<string, ManifestWeapon>;
}

// ============================================================================
// Component
// ============================================================================

export function WeaponSheetEditor() {
  // Weapon list
  const [weapons, setWeapons] = useState<ManifestWeapon[]>([]);
  const [selectedWeaponId, setSelectedWeaponId] = useState<string | null>(null);

  // Current weapon schema
  const [schema, setSchema] = useState<WeaponAtlasSchema | null>(null);
  const [atlasUrl, setAtlasUrl] = useState<string | null>(null);

  // Selected cell for detailed editing
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [hoveredCell, setHoveredCell] = useState<WeaponCell | null>(null);

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

  // Animation preview
  const [isPlaying, setIsPlaying] = useState(false);
  const [_previewFrame, setPreviewFrame] = useState(0);

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
      setWeapons(Object.values(manifest.weapons));
    } catch (e) {
      console.error('Failed to load manifest:', e);
      setError('Failed to load asset manifest');
    } finally {
      setIsLoading(false);
    }
  }

  // Select weapon
  const selectWeapon = useCallback(async (weaponId: string) => {
    const weapon = weapons.find(w => w.id === weaponId);
    if (!weapon) return;

    setSelectedWeaponId(weaponId);
    setSelectedCell(null);
    setHasUnsavedChanges(false);

    // Build schema from manifest data
    const weaponSchema = buildWeaponSchema(
      weapon.id,
      weapon.name,
      weapon.animations,
      weapon.anchorX,
      weapon.anchorY,
      weapon.spriteSize
    );
    setSchema(weaponSchema);

    // Set atlas URL
    const storage = createStorage({ basePath: 'assets' });
    const url = storage.getReadUrl(weapon.atlas);
    setAtlasUrl(url);
  }, [weapons]);

  // Handle cell selection
  const handleCellSelect = useCallback((cell: WeaponCell | null) => {
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
    setHoveredCell(cell as WeaponCell | null);
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
    if (!selectedWeaponId || !sheetRef.current || !schema) return;

    setIsSaving(true);
    setError(null);

    try {
      const storage = createStorage({ basePath: 'assets' });

      // Get atlas as data URL then convert to blob
      const dataUrl = sheetRef.current.getAtlasDataUrl();
      const response = await fetch(dataUrl);
      const blob = await response.blob();

      // Save to assets folder
      const atlasPath = `weapons/${selectedWeaponId}.png`;
      await storage.writeBytes(atlasPath, await blob.arrayBuffer(), 'image/png');

      setHasUnsavedChanges(false);
      console.log(`Saved atlas: ${atlasPath}`);
    } catch (e) {
      setError(`Failed to save: ${e}`);
    } finally {
      setIsSaving(false);
    }
  }, [selectedWeaponId, schema]);

  // Copy cell to all frames in row
  const copyCellToRow = useCallback(() => {
    if (!selectedCell || !sheetRef.current || !schema) return;

    const srcData = sheetRef.current.getCellImageData(selectedCell.row, selectedCell.col);
    const rowInfo = schema.rows[selectedCell.row];
    if (!rowInfo) return;

    for (let col = 0; col < rowInfo.frames; col++) {
      if (col !== selectedCell.col) {
        sheetRef.current.setCellImageData(selectedCell.row, col, srcData);
      }
    }
    setHasUnsavedChanges(true);
  }, [selectedCell, schema]);

  // Animation preview
  useEffect(() => {
    if (!isPlaying || !schema || selectedCell === null) return;

    const rowInfo = schema.rows[selectedCell.row];
    if (!rowInfo) return;

    const interval = setInterval(() => {
      setPreviewFrame(f => (f + 1) % rowInfo.frames);
    }, 100);

    return () => clearInterval(interval);
  }, [isPlaying, schema, selectedCell]);

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
        case ' ':
          e.preventDefault();
          setIsPlaying(p => !p);
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

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar - Weapon list */}
      <div
        style={{
          width: 220,
          background: '#16213e',
          padding: '1rem',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ color: '#4ecca3', margin: '0 0 1rem 0', fontSize: '1rem' }}>
          Weapon Sheets
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

        {weapons.map(weapon => (
          <div
            key={weapon.id}
            onClick={() => selectWeapon(weapon.id)}
            style={{
              padding: '0.5rem',
              background: weapon.id === selectedWeaponId ? '#4ecca3' : '#0f0f23',
              color: weapon.id === selectedWeaponId ? '#1a1a2e' : '#ccc',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '0.25rem',
            }}
          >
            <div style={{ fontWeight: 'bold', fontSize: '0.875rem' }}>{weapon.name}</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{weapon.id}</div>
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
            {selectedWeaponId ? `Editing: ${selectedWeaponId}` : 'Select a weapon'}
          </span>

          {hasUnsavedChanges && (
            <span style={{ color: '#ffd93d', fontSize: '0.875rem' }}>
              (unsaved changes)
            </span>
          )}

          <div style={{ flex: 1 }} />

          <button
            onClick={saveAtlas}
            disabled={isSaving || !selectedWeaponId || !hasUnsavedChanges}
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
                    <>
                      <span style={{ color: '#4ecca3' }}>{hoveredCell.animation}</span>
                      {' frame '}
                      <span style={{ color: '#ffd93d' }}>{hoveredCell.frame + 1}</span>
                      {hoveredCell.isEmpty && (
                        <span style={{ color: '#ff6b6b' }}> (empty)</span>
                      )}
                    </>
                  ) : (
                    'Hover over a cell to see info'
                  )}
                </div>

                {/* Anchor point display */}
                <div style={{ marginBottom: '0.5rem', color: '#666', fontSize: '0.75rem' }}>
                  Anchor: ({schema.anchorX}, {schema.anchorY})
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
                  onCellSelect={(cell) => handleCellSelect(cell as WeaponCell)}
                  onCellHover={handleCellHover}
                  onChange={handleSheetChange}
                />
              </>
            ) : (
              <div style={{ color: '#666', textAlign: 'center', paddingTop: '4rem' }}>
                Select a weapon from the list to edit its sprite sheet
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
                    {schema.rows[selectedCell.row]?.animation || 'Unknown'} - Frame {selectedCell.col + 1}
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
                      Copy to all frames
                    </button>

                    <button
                      onClick={() => setIsPlaying(p => !p)}
                      style={{
                        padding: '0.25rem 0.5rem',
                        border: '1px solid #333',
                        borderRadius: '4px',
                        background: isPlaying ? '#ff6b6b' : '#0f0f23',
                        color: '#ccc',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      {isPlaying ? 'Stop' : 'Preview'}
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

export default WeaponSheetEditor;
