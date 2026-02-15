import { useState, useRef, useCallback, useEffect } from 'react';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import type { Color, Tool, TileDefinition } from '../types';

/** Canvas size for tile sprites */
const TILE_SIZE = 16;

/** Tile editor for creating terrain tiles */
export function TileEditor() {
  // Tile metadata
  const [tileId, setTileId] = useState('');
  const [tileName, setTileName] = useState('');
  const [walkable, setWalkable] = useState(true);
  const [blocksVision, setBlocksVision] = useState(false);
  const [damagePerTurn, setDamagePerTurn] = useState(0);

  // Drawing state
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 });
  const [zoom, setZoom] = useState(24);
  const [showGrid, setShowGrid] = useState(true);
  const [recentColors, setRecentColors] = useState<Color[]>([]);

  // Canvas ref
  const canvasRef = useRef<PixelCanvasRef>(null);

  // Clipboard
  const clipboardRef = useRef<ImageData | null>(null);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [existingTiles, setExistingTiles] = useState<string[]>([]);

  // Load existing tiles on mount
  useEffect(() => {
    async function loadTiles() {
      try {
        const storage = createStorage();
        const files = await storage.list('tiles');
        const ids = [
          ...new Set(
            files
              .filter((f) => f.includes('/') && f.endsWith('definition.json'))
              .map((f) => f.split('/')[1])
          ),
        ];
        setExistingTiles(ids);
      } catch (e) {
        console.error('Failed to load tiles:', e);
      }
    }
    loadTiles();
  }, []);

  // Load tile from storage
  const loadTile = useCallback(async (id: string) => {
    setIsLoading(true);
    setSaveError(null);
    try {
      const storage = createStorage();

      // Load definition
      const defJson = await storage.readText(`tiles/${id}/definition.json`);
      const def: TileDefinition = JSON.parse(defJson);
      setTileId(def.id);
      setTileName(def.name);
      setWalkable(def.walkable);
      setBlocksVision(def.blocksVision);
      setDamagePerTurn(def.damagePerTurn);

      // Load sprite image
      try {
        const url = storage.getReadUrl(`tiles/${id}/sprite.png`);
        const img = await loadImage(url);
        const data = imageToImageData(img, TILE_SIZE, TILE_SIZE);
        canvasRef.current?.setImageData(data);
      } catch {
        // Sprite doesn't exist yet
        canvasRef.current?.clear();
      }
    } catch (e) {
      setSaveError(`Failed to load tile: ${e}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save tile to storage
  const saveTile = useCallback(async () => {
    if (!tileId.trim()) {
      setSaveError('Tile ID is required');
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    try {
      const storage = createStorage();
      const now = new Date().toISOString();

      // Save definition
      const def: TileDefinition = {
        id: tileId,
        name: tileName || tileId,
        walkable,
        blocksVision,
        damagePerTurn,
        createdAt: now,
        updatedAt: now,
      };
      await storage.writeText(
        `tiles/${tileId}/definition.json`,
        JSON.stringify(def, null, 2)
      );

      // Save sprite
      const data = canvasRef.current?.getImageData();
      if (data) {
        const blob = await imageDataToPng(data);
        await storage.writeBytes(
          `tiles/${tileId}/sprite.png`,
          await blob.arrayBuffer(),
          'image/png'
        );
      }

      // Update existing tiles list
      if (!existingTiles.includes(tileId)) {
        setExistingTiles([...existingTiles, tileId]);
      }

      console.log(`Saved tile ${tileId}`);
    } catch (e) {
      setSaveError(`Failed to save: ${e}`);
    } finally {
      setIsSaving(false);
    }
  }, [tileId, tileName, walkable, blocksVision, damagePerTurn, existingTiles]);

  // Add color to recent
  const addRecentColor = useCallback((c: Color) => {
    setRecentColors((prev) => {
      const exists = prev.some(
        (p) => p.r === c.r && p.g === c.g && p.b === c.b && p.a === c.a
      );
      if (exists) return prev;
      return [c, ...prev.slice(0, 15)];
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              canvasRef.current?.redo();
            } else {
              canvasRef.current?.undo();
            }
            break;
          case 'c':
            e.preventDefault();
            clipboardRef.current = canvasRef.current?.copySelection() || null;
            break;
          case 'v':
            e.preventDefault();
            if (clipboardRef.current) {
              canvasRef.current?.pasteSelection(clipboardRef.current);
            }
            break;
          case 's':
            e.preventDefault();
            saveTile();
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
        case 'm':
          setTool('select');
          break;
        case 'i':
          setTool('eyedropper');
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveTile]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar - Tile list */}
      <div
        style={{
          width: 200,
          background: '#16213e',
          padding: '1rem',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ color: '#4ecca3', margin: '0 0 1rem 0', fontSize: '1rem' }}>
          Tiles
        </h3>

        <button
          onClick={() => {
            setTileId('');
            setTileName('');
            setWalkable(true);
            setBlocksVision(false);
            setDamagePerTurn(0);
            canvasRef.current?.clear();
          }}
          style={{
            width: '100%',
            padding: '0.5rem',
            background: '#4ecca3',
            color: '#1a1a2e',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold',
            marginBottom: '0.5rem',
          }}
        >
          + New Tile
        </button>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {existingTiles.map((id) => (
            <TilePreview
              key={id}
              id={id}
              selected={id === tileId}
              onClick={() => loadTile(id)}
            />
          ))}
        </div>
      </div>

      {/* Main editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar - Tile info */}
        <div
          style={{
            padding: '0.5rem 1rem',
            background: '#16213e',
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>ID:</span>
            <input
              type="text"
              value={tileId}
              onChange={(e) => setTileId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="tile_id"
              style={{
                background: '#0f0f23',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '0.25rem 0.5rem',
                color: '#ccc',
                width: 100,
              }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Name:</span>
            <input
              type="text"
              value={tileName}
              onChange={(e) => setTileName(e.target.value)}
              placeholder="Display Name"
              style={{
                background: '#0f0f23',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '0.25rem 0.5rem',
                color: '#ccc',
                width: 120,
              }}
            />
          </label>

          <div style={{ width: 1, height: 24, background: '#333' }} />

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={walkable}
              onChange={(e) => setWalkable(e.target.checked)}
            />
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Walkable</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={blocksVision}
              onChange={(e) => setBlocksVision(e.target.checked)}
            />
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Blocks Vision</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Damage:</span>
            <input
              type="number"
              value={damagePerTurn}
              onChange={(e) => setDamagePerTurn(Math.max(0, parseInt(e.target.value, 10) || 0))}
              min={0}
              style={{
                background: '#0f0f23',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '0.25rem 0.5rem',
                color: '#ccc',
                width: 60,
              }}
            />
          </label>

          <div style={{ flex: 1 }} />

          <button
            onClick={saveTile}
            disabled={isSaving || !tileId}
            style={{
              padding: '0.5rem 1rem',
              background: isSaving ? '#555' : '#4ecca3',
              color: isSaving ? '#999' : '#1a1a2e',
              border: 'none',
              borderRadius: '4px',
              cursor: isSaving || !tileId ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
            }}
          >
            {isSaving ? 'Saving...' : 'Save (Ctrl+S)'}
          </button>

          {saveError && (
            <span style={{ color: '#ff6b6b', fontSize: '0.875rem' }}>{saveError}</span>
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
          onUndo={() => canvasRef.current?.undo()}
          onRedo={() => canvasRef.current?.redo()}
          canUndo={canvasRef.current?.canUndo() ?? false}
          canRedo={canvasRef.current?.canRedo() ?? false}
          onClear={() => canvasRef.current?.clear()}
          onRotateCW={() => canvasRef.current?.rotateClockwise()}
          onRotateCCW={() => canvasRef.current?.rotateCounterClockwise()}
          onFlipH={() => canvasRef.current?.flipHorizontal()}
          onFlipV={() => canvasRef.current?.flipVertical()}
          onCopy={() => {
            clipboardRef.current = canvasRef.current?.copySelection() || canvasRef.current?.getImageData() || null;
          }}
          onPaste={() => {
            if (clipboardRef.current) {
              canvasRef.current?.pasteSelection(clipboardRef.current);
            }
          }}
          onDelete={() => canvasRef.current?.deleteSelection()}
        />

        {/* Main content area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Canvas area */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '1rem',
              background: '#0f0f23',
            }}
          >
            <PixelCanvas
              ref={canvasRef}
              width={TILE_SIZE}
              height={TILE_SIZE}
              zoom={zoom}
              tool={tool}
              color={color}
              showGrid={showGrid}
              onColorPick={(c) => setColor(c)}
            />

            {/* Preview at different scales */}
            <div style={{ marginTop: '2rem', display: 'flex', gap: '2rem' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#666', fontSize: '0.75rem', marginBottom: '0.25rem' }}>1x</div>
                <TilePreviewFromCanvas canvasRef={canvasRef} size={TILE_SIZE} scale={1} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#666', fontSize: '0.75rem', marginBottom: '0.25rem' }}>2x</div>
                <TilePreviewFromCanvas canvasRef={canvasRef} size={TILE_SIZE} scale={2} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#666', fontSize: '0.75rem', marginBottom: '0.25rem' }}>4x</div>
                <TilePreviewFromCanvas canvasRef={canvasRef} size={TILE_SIZE} scale={4} />
              </div>

              {/* Tiled preview */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#666', fontSize: '0.75rem', marginBottom: '0.25rem' }}>Tiled</div>
                <TiledPreview canvasRef={canvasRef} tileSize={TILE_SIZE} gridSize={4} scale={2} />
              </div>
            </div>
          </div>

          {/* Right sidebar - Color picker */}
          <div
            style={{
              width: 220,
              background: '#16213e',
              padding: '0.5rem',
              overflowY: 'auto',
            }}
          >
            <ColorPicker
              color={color}
              onChange={setColor}
              recentColors={recentColors}
              onAddRecent={addRecentColor}
            />
          </div>
        </div>
      </div>

      {/* Loading overlay */}
      {isLoading && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{ color: '#4ecca3', fontSize: '1.5rem' }}>Loading...</div>
        </div>
      )}
    </div>
  );
}

/** Tile preview in list */
function TilePreview({
  id,
  selected,
  onClick,
}: {
  id: string;
  selected: boolean;
  onClick: () => void;
}) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);

  useEffect(() => {
    async function loadPreview() {
      try {
        const storage = createStorage();
        const url = storage.getReadUrl(`tiles/${id}/sprite.png`);
        setImgSrc(url);
      } catch {
        setImgSrc(null);
      }
    }
    loadPreview();
  }, [id]);

  return (
    <div
      onClick={onClick}
      title={id}
      style={{
        width: 40,
        height: 40,
        background: selected ? '#4ecca3' : '#0f0f23',
        borderRadius: '4px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: selected ? '2px solid #4ecca3' : '1px solid #333',
      }}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt={id}
          style={{
            width: 32,
            height: 32,
            imageRendering: 'pixelated',
          }}
        />
      ) : (
        <span style={{ color: '#666', fontSize: '0.625rem' }}>{id.slice(0, 3)}</span>
      )}
    </div>
  );
}

/** Preview from canvas data at given scale */
function TilePreviewFromCanvas({
  canvasRef,
  size,
  scale,
}: {
  canvasRef: React.RefObject<PixelCanvasRef | null>;
  size: number;
  scale: number;
}) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const canvas = previewCanvasRef.current;
      if (!canvas || !canvasRef.current) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const data = canvasRef.current.getImageData();
      if (!data) return;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = size;
      tempCanvas.height = size;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;
      tempCtx.putImageData(data, 0, 0);

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempCanvas, 0, 0, size * scale, size * scale);
    }, 100);

    return () => clearInterval(interval);
  }, [canvasRef, size, scale]);

  return (
    <canvas
      ref={previewCanvasRef}
      width={size * scale}
      height={size * scale}
      style={{
        background: '#111',
        borderRadius: '4px',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/** Tiled preview showing tile repeated in a grid */
function TiledPreview({
  canvasRef,
  tileSize,
  gridSize,
  scale,
}: {
  canvasRef: React.RefObject<PixelCanvasRef | null>;
  tileSize: number;
  gridSize: number;
  scale: number;
}) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const canvas = previewCanvasRef.current;
      if (!canvas || !canvasRef.current) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const data = canvasRef.current.getImageData();
      if (!data) return;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = tileSize;
      tempCanvas.height = tileSize;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return;
      tempCtx.putImageData(data, 0, 0);

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const scaledTile = tileSize * scale;
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          ctx.drawImage(
            tempCanvas,
            x * scaledTile,
            y * scaledTile,
            scaledTile,
            scaledTile
          );
        }
      }
    }, 100);

    return () => clearInterval(interval);
  }, [canvasRef, tileSize, gridSize, scale]);

  return (
    <canvas
      ref={previewCanvasRef}
      width={tileSize * scale * gridSize}
      height={tileSize * scale * gridSize}
      style={{
        background: '#111',
        borderRadius: '4px',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/** Load image from URL */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Convert image to ImageData */
function imageToImageData(
  img: HTMLImageElement,
  width: number,
  height: number
): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** Convert ImageData to PNG blob */
function imageDataToPng(data: ImageData): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }
    ctx.putImageData(data, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to create blob'));
      }
    }, 'image/png');
  });
}

export default TileEditor;
