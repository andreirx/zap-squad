import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, Copy, ChevronLeft, ChevronRight, Trash2, Upload } from 'lucide-react';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import { importImageToImageData } from '../importImage';
import type { Color, Tool } from '../types';

/** Canvas size for tile sprites - EVERYTHING IS 128x128 */
const TILE_SIZE = 128;
const MAX_VARIATIONS = 8;
const PATH_VARIATIONS = 15;
const DEFAULT_PATH_WIDTH = 56;
const PATH_FADE_PIXELS = 4;

// Transition tile constants (for terrain edge blending)
const TRANSITION_SOLID_PIXELS = 32;
const TRANSITION_FADE_PIXELS = 32;
const TRANSITION_DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
type TransitionDirection = typeof TRANSITION_DIRECTIONS[number];

type TileType = 'TILE' | 'PATH' | 'BRIDGE';
type TerrainType = 'LAND' | 'WATER';

interface TileProperties {
  id: string;
  name: string;
  tileType: TileType;
  terrainType: TerrainType;
  passable: boolean;
  movementCost: number;
  variations: number;
  pathWidth?: number;
  bridgeAssetId?: string;  // For PATH tiles: which bridge tile to render when crossing water
  createdAt?: string;
  updatedAt?: string;
}

// Path direction combinations (15 total)
const PATH_DIRECTIONS = [
  { up: false, down: false, left: false, right: true, label: 'R' },
  { up: false, down: false, left: true, right: false, label: 'L' },
  { up: false, down: false, left: true, right: true, label: 'LR' },
  { up: false, down: true, left: false, right: false, label: 'D' },
  { up: false, down: true, left: false, right: true, label: 'DR' },
  { up: false, down: true, left: true, right: false, label: 'DL' },
  { up: false, down: true, left: true, right: true, label: 'DLR' },
  { up: true, down: false, left: false, right: false, label: 'U' },
  { up: true, down: false, left: false, right: true, label: 'UR' },
  { up: true, down: false, left: true, right: false, label: 'UL' },
  { up: true, down: false, left: true, right: true, label: 'ULR' },
  { up: true, down: true, left: false, right: false, label: 'UD' },
  { up: true, down: true, left: false, right: true, label: 'UDR' },
  { up: true, down: true, left: true, right: false, label: 'UDL' },
  { up: true, down: true, left: true, right: true, label: '+' },
];

// Default colors
const DEFAULT_TERRAIN_COLORS = ['#228b22', '#2e8b57', '#32cd32'];
const DEFAULT_PATH_COLORS = ['#8b7355', '#a0826d', '#c4a882'];
const DEFAULT_WATER_COLORS = ['#1e90ff', '#4169e1', '#6495ed'];

/** Tile editor with variations, types, and generation tools */
export function TileEditor() {
  // Tile metadata
  const [tileId, setTileId] = useState('');
  const [tileName, setTileName] = useState('');
  const [tileType, setTileType] = useState<TileType>('TILE');
  const [terrainType, setTerrainType] = useState<TerrainType>('LAND');
  const [passable, setPassable] = useState(true);
  const [movementCost, setMovementCost] = useState(1);
  const [pathWidth, setPathWidth] = useState(DEFAULT_PATH_WIDTH);
  const [bridgeAssetId, setBridgeAssetId] = useState<string | undefined>(undefined);
  const [availableBridges, setAvailableBridges] = useState<{ id: string; name: string }[]>([]);

  // Variations data
  const [variations, setVariations] = useState<Map<number, ImageData>>(new Map());
  const [currentVariation, setCurrentVariation] = useState(0);
  const [variationCount, setVariationCount] = useState(1);

  // Generation colors
  const [terrainColors, setTerrainColors] = useState(DEFAULT_TERRAIN_COLORS);
  const [pathColors, setPathColors] = useState(DEFAULT_PATH_COLORS);

  // Drawing state
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<Color>({ r: 34, g: 139, b: 34, a: 255 });
  const [zoom, setZoom] = useState(4);
  const [brushSize, setBrushSize] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [recentColors, setRecentColors] = useState<Color[]>([]);

  // Canvas ref
  const canvasRef = useRef<PixelCanvasRef>(null);
  const clipboardRef = useRef<ImageData | null>(null);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [existingTiles, setExistingTiles] = useState<string[]>([]);

  // Effective variation count based on tile type
  const effectiveVariationCount = tileType === 'TILE' ? variationCount : PATH_VARIATIONS;

  // Save current canvas to variations
  const saveCurrentVariation = useCallback(() => {
    if (!canvasRef.current) return;
    const data = canvasRef.current.getImageData();
    setVariations(prev => {
      const next = new Map(prev);
      next.set(currentVariation, new ImageData(
        new Uint8ClampedArray(data.data),
        data.width,
        data.height
      ));
      return next;
    });
  }, [currentVariation]);

  // Load variation to canvas
  const loadVariation = useCallback((index: number) => {
    const data = variations.get(index);
    if (data && canvasRef.current) {
      canvasRef.current.setImageData(data);
    } else if (canvasRef.current) {
      canvasRef.current.clear();
    }
  }, [variations]);

  // Change variation
  const changeVariation = useCallback((index: number) => {
    saveCurrentVariation();
    setCurrentVariation(index);
  }, [saveCurrentVariation]);

  // Load variation when current changes
  useEffect(() => {
    loadVariation(currentVariation);
  }, [currentVariation, loadVariation]);

  // Update variation count when tile type changes
  useEffect(() => {
    if (tileType !== 'TILE') {
      // PATH and BRIDGE always have 15 variations
      if (currentVariation >= PATH_VARIATIONS) {
        setCurrentVariation(0);
      }
    }
  }, [tileType, currentVariation]);

  // Load existing tiles on mount
  useEffect(() => {
    async function loadTiles() {
      try {
        const storage = createStorage();
        const files = await storage.list('tiles');
        // Support both properties.json (hexmanos) and definition.json
        const ids = [
          ...new Set(
            files
              .filter((f) => f.includes('/') && (f.endsWith('properties.json') || f.endsWith('definition.json')))
              .map((f) => f.split('/')[1])
          ),
        ];
        setExistingTiles(ids);

        // Load bridge tiles for the bridge selector
        const bridges: { id: string; name: string }[] = [];
        for (const id of ids) {
          try {
            let props: Record<string, unknown> = {};
            try {
              const propsJson = await storage.readText(`tiles/${id}/properties.json`);
              props = JSON.parse(propsJson);
            } catch {
              const defJson = await storage.readText(`tiles/${id}/definition.json`);
              props = JSON.parse(defJson);
            }
            if (props.tileType === 'BRIDGE') {
              bridges.push({ id, name: (props.name as string) || id });
            }
          } catch {
            // Skip tiles that fail to load
          }
        }
        setAvailableBridges(bridges);
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

      // Try properties.json first (hexmanos format), then definition.json
      let props: TileProperties;
      try {
        const propsJson = await storage.readText(`tiles/${id}/properties.json`);
        props = JSON.parse(propsJson);
      } catch {
        const defJson = await storage.readText(`tiles/${id}/definition.json`);
        props = JSON.parse(defJson);
      }

      setTileId(props.id || id);
      setTileName(props.name || id);
      setTileType(props.tileType || 'TILE');
      const terrain = props.terrainType || 'LAND';
      setTerrainType(terrain);
      // Passable is derived from terrainType: LAND = passable, WATER = impassable
      setPassable(terrain === 'LAND');
      setMovementCost(props.movementCost ?? 1);
      setPathWidth(props.pathWidth ?? DEFAULT_PATH_WIDTH);
      setBridgeAssetId((props as TileProperties).bridgeAssetId);

      const varCount = props.variations || 1;
      setVariationCount(varCount);

      // Load all variation images
      const newVariations = new Map<number, ImageData>();
      const maxVars = props.tileType === 'TILE' ? varCount : PATH_VARIATIONS;

      for (let i = 0; i < maxVars; i++) {
        try {
          const url = storage.getReadUrl(`tiles/${id}/tile_${i}.png`);
          const img = await loadImage(url);
          const data = imageToImageData(img, TILE_SIZE, TILE_SIZE);
          newVariations.set(i, data);
        } catch {
          // Variation doesn't exist
        }
      }

      setVariations(newVariations);
      setCurrentVariation(0);

      // Load first variation to canvas
      const firstVar = newVariations.get(0);
      if (firstVar && canvasRef.current) {
        canvasRef.current.setImageData(firstVar);
      } else if (canvasRef.current) {
        canvasRef.current.clear();
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

    saveCurrentVariation();

    setIsSaving(true);
    try {
      const storage = createStorage();
      const now = new Date().toISOString();

      // Save properties
      const props: TileProperties = {
        id: tileId,
        name: tileName || tileId,
        tileType,
        terrainType,
        passable,
        movementCost,
        variations: tileType === 'TILE' ? variationCount : PATH_VARIATIONS,
        pathWidth: tileType !== 'TILE' ? pathWidth : undefined,
        bridgeAssetId: tileType === 'PATH' && terrainType === 'LAND' ? bridgeAssetId : undefined,
        createdAt: now,
        updatedAt: now,
      };
      await storage.writeText(
        `tiles/${tileId}/properties.json`,
        JSON.stringify(props, null, 2)
      );

      // Save all variations
      for (const [index, data] of variations.entries()) {
        const blob = await imageDataToPng(data);
        await storage.writeBytes(
          `tiles/${tileId}/tile_${index}.png`,
          await blob.arrayBuffer(),
          'image/png'
        );
      }

      // Auto-generate transitions for TILE type (only for tile_0)
      if (tileType === 'TILE') {
        const tile0Data = variations.get(0);
        if (tile0Data) {
          for (const direction of TRANSITION_DIRECTIONS) {
            const transitionData = generateTransitionImage(tile0Data, direction);
            const transitionBlob = await imageDataToPng(transitionData);
            await storage.writeBytes(
              `tiles/${tileId}/tile_0_transition_${direction}.png`,
              await transitionBlob.arrayBuffer(),
              'image/png'
            );
          }
        }
      }

      if (!existingTiles.includes(tileId)) {
        setExistingTiles([...existingTiles, tileId]);
      }

      const transitionInfo = tileType === 'TILE' ? ' + 8 transitions' : '';
      console.log(`Saved tile ${tileId} with ${variations.size} variations${transitionInfo}`);

      // Post-save warning for land paths without bridge
      if (tileType === 'PATH' && terrainType === 'LAND' && !bridgeAssetId) {
        setSaveError('Saved, but warning: no bridge assigned. Paths crossing impassable terrain will not show bridges.');
      }
    } catch (e) {
      setSaveError(`Failed to save: ${e}`);
    } finally {
      setIsSaving(false);
    }
  }, [tileId, tileName, tileType, terrainType, passable, movementCost, pathWidth, bridgeAssetId, variationCount, variations, existingTiles, saveCurrentVariation]);

  // Add variation (TILE type only)
  const addVariation = useCallback(() => {
    if (tileType !== 'TILE' || variationCount >= MAX_VARIATIONS) return;
    saveCurrentVariation();
    setVariationCount(prev => prev + 1);
    setCurrentVariation(variationCount);
  }, [tileType, variationCount, saveCurrentVariation]);

  // Duplicate variation (TILE type only)
  const duplicateVariation = useCallback(() => {
    if (tileType !== 'TILE' || variationCount >= MAX_VARIATIONS) return;
    saveCurrentVariation();
    const currentData = variations.get(currentVariation);
    if (currentData) {
      const newIndex = variationCount;
      setVariations(prev => {
        const next = new Map(prev);
        next.set(newIndex, new ImageData(
          new Uint8ClampedArray(currentData.data),
          currentData.width,
          currentData.height
        ));
        return next;
      });
      setVariationCount(prev => prev + 1);
      setCurrentVariation(newIndex);
    }
  }, [tileType, variationCount, currentVariation, variations, saveCurrentVariation]);

  // Delete variation (TILE type only)
  const deleteVariation = useCallback(() => {
    if (tileType !== 'TILE' || variationCount <= 1) return;
    saveCurrentVariation();

    setVariations(prev => {
      const next = new Map<number, ImageData>();
      let newIndex = 0;
      for (let i = 0; i < variationCount; i++) {
        if (i !== currentVariation) {
          const data = prev.get(i);
          if (data) {
            next.set(newIndex, data);
          }
          newIndex++;
        }
      }
      return next;
    });

    setVariationCount(prev => prev - 1);
    setCurrentVariation(prev => Math.max(0, prev - 1));
  }, [tileType, variationCount, currentVariation, saveCurrentVariation]);

  // Import image from file (PNG/JPG) into current variation
  const handleImportImage = useCallback(async () => {
    console.log('[TileEditor] import image requested, variation:', currentVariation);
    const result = await importImageToImageData(TILE_SIZE);
    if (!result) { console.log('[TileEditor] import cancelled or failed'); return; }
    console.log('[TileEditor] setting imported image on canvas:', result.fileName);
    canvasRef.current?.setImageData(result.imageData);
  }, [currentVariation]);

  // Generate random fill for current variation
  const generateRandomFill = useCallback(() => {
    if (!canvasRef.current) return;

    const colors = terrainType === 'WATER' ? DEFAULT_WATER_COLORS : terrainColors;
    const parsedColors = colors.map(parseHexColor);

    const data = new ImageData(TILE_SIZE, TILE_SIZE);
    for (let i = 0; i < data.data.length; i += 4) {
      const c = parsedColors[Math.floor(Math.random() * parsedColors.length)];
      data.data[i] = c.r;
      data.data[i + 1] = c.g;
      data.data[i + 2] = c.b;
      data.data[i + 3] = 255;
    }

    canvasRef.current.setImageData(data);
    saveCurrentVariation();
  }, [terrainType, terrainColors, saveCurrentVariation]);

  // Fill all 15 variations with random background (no paths)
  const fillAllBackgrounds = useCallback(() => {
    if (tileType === 'TILE') return;

    saveCurrentVariation();
    const bgColors = terrainType === 'WATER' ? DEFAULT_WATER_COLORS : terrainColors;
    const parsedBgColors = bgColors.map(parseHexColor);

    const newVariations = new Map<number, ImageData>();

    for (let i = 0; i < PATH_VARIATIONS; i++) {
      const data = new ImageData(TILE_SIZE, TILE_SIZE);

      // Fill with random background colors
      for (let j = 0; j < data.data.length; j += 4) {
        const c = parsedBgColors[Math.floor(Math.random() * parsedBgColors.length)];
        data.data[j] = c.r;
        data.data[j + 1] = c.g;
        data.data[j + 2] = c.b;
        data.data[j + 3] = 255;
      }

      newVariations.set(i, data);
    }

    setVariations(newVariations);
    setCurrentVariation(0);
    // Load first variation directly (can't use loadVariation as state hasn't updated yet)
    const firstVar = newVariations.get(0);
    if (firstVar && canvasRef.current) {
      canvasRef.current.setImageData(firstVar);
    }
  }, [tileType, terrainType, terrainColors, saveCurrentVariation]);

  // Draw path on existing pixels with fading edges
  const drawPathOnPixels = (
    existingData: Uint8ClampedArray,
    dir: { up: boolean; down: boolean; left: boolean; right: boolean },
    parsedPathColors: { r: number; g: number; b: number }[]
  ): ImageData => {
    const data = new ImageData(TILE_SIZE, TILE_SIZE);
    // Copy existing pixels
    data.data.set(existingData);

    // Calculate path bounds for each direction
    const cStart = Math.round((TILE_SIZE - pathWidth) / 2);
    const cEnd = Math.round((TILE_SIZE + pathWidth) / 2);

    // Helper to draw a path segment
    const drawSegment = (
      xStart: number, xEnd: number,
      yStart: number, yEnd: number,
      fadeLeft: boolean, fadeRight: boolean,
      fadeTop: boolean, fadeBottom: boolean
    ) => {
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const idx = (y * TILE_SIZE + x) * 4;
          const pathColor = parsedPathColors[Math.floor(Math.random() * parsedPathColors.length)];

          // Calculate fade factor for each edge
          let fadeFactor = 0;

          if (fadeLeft && x >= xStart && x < xStart + PATH_FADE_PIXELS) {
            fadeFactor = Math.max(fadeFactor, 1 - (x - xStart + 1) / PATH_FADE_PIXELS);
          }
          if (fadeRight && x >= xEnd - PATH_FADE_PIXELS && x < xEnd) {
            fadeFactor = Math.max(fadeFactor, 1 - (xEnd - 1 - x + 1) / PATH_FADE_PIXELS);
          }
          if (fadeTop && y >= yStart && y < yStart + PATH_FADE_PIXELS) {
            fadeFactor = Math.max(fadeFactor, 1 - (y - yStart + 1) / PATH_FADE_PIXELS);
          }
          if (fadeBottom && y >= yEnd - PATH_FADE_PIXELS && y < yEnd) {
            fadeFactor = Math.max(fadeFactor, 1 - (yEnd - 1 - y + 1) / PATH_FADE_PIXELS);
          }

          if (fadeFactor > 0) {
            // Blend with existing pixel
            const bgR = data.data[idx];
            const bgG = data.data[idx + 1];
            const bgB = data.data[idx + 2];
            const bgA = data.data[idx + 3];

            data.data[idx] = Math.round(pathColor.r * (1 - fadeFactor) + bgR * fadeFactor);
            data.data[idx + 1] = Math.round(pathColor.g * (1 - fadeFactor) + bgG * fadeFactor);
            data.data[idx + 2] = Math.round(pathColor.b * (1 - fadeFactor) + bgB * fadeFactor);
            data.data[idx + 3] = Math.max(255, bgA);
          } else {
            // Full path color
            data.data[idx] = pathColor.r;
            data.data[idx + 1] = pathColor.g;
            data.data[idx + 2] = pathColor.b;
            data.data[idx + 3] = 255;
          }
        }
      }
    };

    // Draw each direction segment
    if (dir.up) {
      drawSegment(cStart, cEnd, 0, cEnd, true, true, false, true);
    }
    if (dir.down) {
      drawSegment(cStart, cEnd, cStart, TILE_SIZE, true, true, true, false);
    }
    if (dir.left) {
      drawSegment(0, cEnd, cStart, cEnd, false, true, true, true);
    }
    if (dir.right) {
      drawSegment(cStart, TILE_SIZE, cStart, cEnd, true, false, true, true);
    }

    return data;
  };

  // Generate paths on all 15 variations (draws ON TOP of existing pixels)
  const generateAllPaths = useCallback(() => {
    if (tileType === 'TILE') return;

    saveCurrentVariation();
    const parsedPathColors = pathColors.map(parseHexColor);

    const newVariations = new Map<number, ImageData>();

    for (let i = 0; i < PATH_VARIATIONS; i++) {
      const dir = PATH_DIRECTIONS[i];
      const existing = variations.get(i);

      // Get existing pixels or create transparent canvas
      const existingData = existing
        ? new Uint8ClampedArray(existing.data)
        : new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);

      const data = drawPathOnPixels(existingData, dir, parsedPathColors);
      newVariations.set(i, data);
    }

    setVariations(newVariations);
    setCurrentVariation(0);
    // Load first variation directly (can't use loadVariation as state hasn't updated yet)
    const firstVar = newVariations.get(0);
    if (firstVar && canvasRef.current) {
      canvasRef.current.setImageData(firstVar);
    }
  }, [tileType, pathColors, pathWidth, variations, saveCurrentVariation]);

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

  // New tile
  const newTile = useCallback(() => {
    setTileId('');
    setTileName('');
    setTileType('TILE');
    setTerrainType('LAND');
    setPassable(true);
    setMovementCost(1);
    setPathWidth(DEFAULT_PATH_WIDTH);
    setBridgeAssetId(undefined);
    setVariations(new Map());
    setVariationCount(1);
    setCurrentVariation(0);
    canvasRef.current?.clear();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) canvasRef.current?.redo();
            else canvasRef.current?.undo();
            break;
          case 's':
            e.preventDefault();
            saveTile();
            break;
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'p': setTool('pencil'); break;
        case 'e': setTool('eraser'); break;
        case 'g': setTool('fill'); break;
        case 'l': setTool('line'); break;
        case '[': changeVariation(Math.max(0, currentVariation - 1)); break;
        case ']': changeVariation(Math.min(effectiveVariationCount - 1, currentVariation + 1)); break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveTile, currentVariation, effectiveVariationCount, changeVariation]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar - Tile list */}
      <div style={{ width: 200, background: '#16213e', padding: '1rem', overflowY: 'auto' }}>
        <h3 style={{ color: '#4ecca3', margin: '0 0 1rem 0', fontSize: '1rem' }}>Tiles</h3>

        <button
          onClick={newTile}
          style={{
            width: '100%', padding: '0.5rem', background: '#4ecca3', color: '#1a1a2e',
            border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', marginBottom: '0.5rem',
          }}
        >
          + New Tile
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {existingTiles.map((id) => (
            <div
              key={id}
              onClick={() => loadTile(id)}
              style={{
                padding: '0.5rem', background: id === tileId ? '#4ecca3' : '#0f0f23',
                color: id === tileId ? '#1a1a2e' : '#ccc', borderRadius: '4px', cursor: 'pointer',
                fontSize: '0.875rem',
              }}
            >
              {id}
            </div>
          ))}
        </div>
      </div>

      {/* Main editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <div style={{ padding: '0.5rem 1rem', background: '#16213e', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>ID:</span>
            <input
              type="text" value={tileId}
              onChange={(e) => setTileId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              style={{ background: '#0f0f23', border: '1px solid #333', borderRadius: '4px', padding: '0.25rem 0.5rem', color: '#ccc', width: 100 }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Name:</span>
            <input
              type="text" value={tileName}
              onChange={(e) => setTileName(e.target.value)}
              style={{ background: '#0f0f23', border: '1px solid #333', borderRadius: '4px', padding: '0.25rem 0.5rem', color: '#ccc', width: 120 }}
            />
          </label>

          {/* Tile Type */}
          <div style={{ display: 'flex', gap: '2px' }}>
            {(['TILE', 'PATH', 'BRIDGE'] as TileType[]).map(t => (
              <button
                key={t}
                onClick={() => setTileType(t)}
                style={{
                  padding: '0.25rem 0.5rem', border: 'none', borderRadius: '4px',
                  background: tileType === t ? '#4ecca3' : '#0f0f23',
                  color: tileType === t ? '#1a1a2e' : '#ccc', cursor: 'pointer', fontSize: '0.75rem',
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Passable toggle — controls both terrainType and passable in one click.
              LAND = passable, WATER = impassable. No way to mismatch. */}
          <button
            onClick={() => {
              const newTerrain: TerrainType = terrainType === 'LAND' ? 'WATER' : 'LAND';
              setTerrainType(newTerrain);
              setPassable(newTerrain === 'LAND');
            }}
            style={{
              padding: '0.25rem 0.75rem', border: 'none', borderRadius: '4px',
              background: terrainType === 'LAND' ? '#4ecca3' : '#4169e1',
              color: '#fff', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600,
            }}
            title={terrainType === 'LAND'
              ? 'Passable (land) — click to make impassable (water)'
              : 'Impassable (water) — click to make passable (land)'}
          >
            {terrainType === 'LAND' ? 'Passable' : 'Impassable'}
          </button>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ color: '#888', fontSize: '0.75rem' }}>Cost:</span>
            <input
              type="number" value={movementCost} min={0} max={10}
              onChange={(e) => setMovementCost(parseInt(e.target.value) || 0)}
              style={{ background: '#0f0f23', border: '1px solid #333', borderRadius: '4px', padding: '0.25rem', color: '#ccc', width: 40 }}
            />
          </label>

          <div style={{ flex: 1 }} />

          <button
            onClick={saveTile}
            disabled={isSaving || !tileId}
            style={{
              padding: '0.5rem 1rem', background: isSaving ? '#555' : '#4ecca3',
              color: isSaving ? '#999' : '#1a1a2e', border: 'none', borderRadius: '4px',
              cursor: isSaving || !tileId ? 'not-allowed' : 'pointer', fontWeight: 'bold',
            }}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>

          {saveError && <span style={{ color: '#ff6b6b', fontSize: '0.75rem' }}>{saveError}</span>}
        </div>

        <Toolbar
          tool={tool} onToolChange={setTool}
          zoom={zoom} onZoomChange={setZoom}
          brushSize={brushSize} onBrushSizeChange={setBrushSize}
          showGrid={showGrid} onShowGridChange={setShowGrid}
          onUndo={() => canvasRef.current?.undo()}
          onRedo={() => canvasRef.current?.redo()}
          canUndo={canvasRef.current?.canUndo() ?? false}
          canRedo={canvasRef.current?.canRedo() ?? false}
          onClear={() => canvasRef.current?.clear()}
          onCopy={() => { clipboardRef.current = canvasRef.current?.getImageData() || null; }}
          onPaste={() => { if (clipboardRef.current) canvasRef.current?.setImageData(clipboardRef.current); }}
        />

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Canvas area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '1rem', background: '#0f0f23', overflow: 'auto' }}>
            {/* Variation selector */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ color: '#666', fontSize: '0.75rem' }}>
                Variation {currentVariation + 1} / {effectiveVariationCount}
                {tileType !== 'TILE' && ` (${PATH_DIRECTIONS[currentVariation]?.label})`}
              </span>

              <button onClick={() => changeVariation(Math.max(0, currentVariation - 1))}
                disabled={currentVariation === 0}
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentVariation === 0 ? '#555' : '#ccc', cursor: currentVariation === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ChevronLeft size={16} />
              </button>

              <button onClick={() => changeVariation(Math.min(effectiveVariationCount - 1, currentVariation + 1))}
                disabled={currentVariation >= effectiveVariationCount - 1}
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentVariation >= effectiveVariationCount - 1 ? '#555' : '#ccc', cursor: currentVariation >= effectiveVariationCount - 1 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ChevronRight size={16} />
              </button>

              <button onClick={handleImportImage}
                title="Import image from file (PNG/JPG)"
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: '#60a0e0', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Upload size={16} />
              </button>
              {tileType === 'TILE' && (
                <>
                  <button onClick={addVariation} disabled={variationCount >= MAX_VARIATIONS}
                    title="Add Variation"
                    style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: variationCount >= MAX_VARIATIONS ? '#555' : '#4ecca3', cursor: variationCount >= MAX_VARIATIONS ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Plus size={16} />
                  </button>
                  <button onClick={duplicateVariation} disabled={variationCount >= MAX_VARIATIONS}
                    title="Duplicate Variation"
                    style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: variationCount >= MAX_VARIATIONS ? '#555' : '#ffd93d', cursor: variationCount >= MAX_VARIATIONS ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Copy size={16} />
                  </button>
                  <button onClick={deleteVariation} disabled={variationCount <= 1}
                    title="Delete Variation"
                    style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: variationCount <= 1 ? '#555' : '#ff6b6b', cursor: variationCount <= 1 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Trash2 size={16} />
                  </button>
                </>
              )}
            </div>

            {/* Canvas */}
            <PixelCanvas
              ref={canvasRef}
              width={TILE_SIZE}
              height={TILE_SIZE}
              zoom={zoom}
              onZoomChange={setZoom}
              tool={tool}
              color={color}
              brushSize={brushSize}
              showGrid={showGrid}
              onColorPick={(c) => setColor(c)}
              onChange={() => saveCurrentVariation()}
            />

            {/* Variation thumbnails */}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {Array.from({ length: effectiveVariationCount }, (_, i) => (
                <VariationThumbnail
                  key={i}
                  index={i}
                  data={variations.get(i)}
                  selected={i === currentVariation}
                  label={tileType !== 'TILE' ? PATH_DIRECTIONS[i]?.label : undefined}
                  onClick={() => changeVariation(i)}
                />
              ))}
            </div>
          </div>

          {/* Right sidebar */}
          <div style={{ width: 250, background: '#16213e', padding: '0.5rem', overflowY: 'auto' }}>
            {/* Generation tools */}
            <div style={{ marginBottom: '1rem', padding: '0.5rem', background: '#0f0f23', borderRadius: '4px' }}>
              <div style={{ color: '#4ecca3', fontWeight: 'bold', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                Generation
              </div>

              {/* Terrain colors */}
              <div style={{ marginBottom: '0.5rem' }}>
                <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '0.25rem' }}>Terrain Colors</div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {terrainColors.map((c, i) => (
                    <input key={i} type="color" value={c}
                      onChange={(e) => {
                        const newColors = [...terrainColors];
                        newColors[i] = e.target.value;
                        setTerrainColors(newColors);
                      }}
                      style={{ width: 32, height: 24, border: 'none', cursor: 'pointer' }}
                    />
                  ))}
                </div>
              </div>

              <button onClick={generateRandomFill}
                style={{ width: '100%', padding: '0.5rem', border: 'none', borderRadius: '4px', background: '#4ecca3', color: '#1a1a2e', cursor: 'pointer', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                Random Fill Current
              </button>

              {tileType !== 'TILE' && (
                <>
                  {/* Path colors */}
                  <div style={{ marginBottom: '0.5rem' }}>
                    <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '0.25rem' }}>Path Colors</div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {pathColors.map((c, i) => (
                        <input key={i} type="color" value={c}
                          onChange={(e) => {
                            const newColors = [...pathColors];
                            newColors[i] = e.target.value;
                            setPathColors(newColors);
                          }}
                          style={{ width: 32, height: 24, border: 'none', cursor: 'pointer' }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Path width */}
                  <div style={{ marginBottom: '0.5rem' }}>
                    <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                      Path Width: {pathWidth}px
                    </div>
                    <input type="range" min={16} max={112} value={pathWidth}
                      onChange={(e) => setPathWidth(parseInt(e.target.value))}
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div style={{ color: '#666', fontSize: '0.65rem', marginBottom: '0.25rem' }}>
                    Step 1: Fill backgrounds, Step 2: Draw paths on top
                  </div>

                  <button onClick={fillAllBackgrounds}
                    style={{ width: '100%', padding: '0.5rem', border: 'none', borderRadius: '4px', background: '#4ecca3', color: '#1a1a2e', cursor: 'pointer', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                    1. Fill All Backgrounds
                  </button>

                  <button onClick={generateAllPaths}
                    style={{ width: '100%', padding: '0.5rem', border: 'none', borderRadius: '4px', background: '#ffd93d', color: '#1a1a2e', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 'bold' }}>
                    2. Draw Paths on All 15
                  </button>

                  {/* Bridge selector - only for PATH + LAND tiles */}
                  {terrainType === 'LAND' && availableBridges.length > 0 && (
                    <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid #333' }}>
                      <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                        Bridge for Water Crossing
                      </div>
                      <select
                        value={bridgeAssetId || ''}
                        onChange={(e) => setBridgeAssetId(e.target.value || undefined)}
                        style={{
                          width: '100%',
                          padding: '0.5rem',
                          background: '#16213e',
                          border: '1px solid #333',
                          borderRadius: '4px',
                          color: '#ccc',
                          fontSize: '0.75rem',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="">None</option>
                        {availableBridges.map((bridge) => (
                          <option key={bridge.id} value={bridge.id}>
                            {bridge.name} ({bridge.id})
                          </option>
                        ))}
                      </select>
                      <div style={{ color: '#666', fontSize: '0.65rem', marginTop: '0.25rem' }}>
                        This bridge tile renders when path crosses water
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <ColorPicker
              color={color}
              onChange={setColor}
              recentColors={recentColors}
              onAddRecent={addRecentColor}
            />
          </div>
        </div>
      </div>

      {isLoading && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ color: '#4ecca3', fontSize: '1.5rem' }}>Loading...</div>
        </div>
      )}
    </div>
  );
}

/** Variation thumbnail */
function VariationThumbnail({ index, data, selected, label, onClick }: {
  index: number;
  data?: ImageData;
  selected: boolean;
  label?: string;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 32, 32);
    if (data) {
      const temp = document.createElement('canvas');
      temp.width = data.width;
      temp.height = data.height;
      temp.getContext('2d')!.putImageData(data, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(temp, 0, 0, 32, 32);
    } else {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, 32, 32);
      ctx.fillStyle = '#666';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('?', 16, 20);
    }
  }, [data]);

  return (
    <div onClick={onClick} title={label || `Variation ${index + 1}`}
      style={{ position: 'relative', border: selected ? '2px solid #4ecca3' : '1px solid #333', borderRadius: '4px', cursor: 'pointer' }}>
      <canvas ref={canvasRef} width={32} height={32} style={{ display: 'block', imageRendering: 'pixelated' }} />
      {label && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: '8px', textAlign: 'center', padding: '1px' }}>
          {label}
        </div>
      )}
    </div>
  );
}

// Helpers
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 0, g: 0, b: 0 };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function imageToImageData(img: HTMLImageElement, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function imageDataToPng(data: ImageData): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('No context')); return; }
    ctx.putImageData(data, 0, 0);
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('No blob')), 'image/png');
  });
}

/**
 * Generate a transition tile for terrain edge blending.
 *
 * Direction indicates WHERE the transition will be PLACED (the neighbor cell).
 * So transition_n.png is placed in the cell NORTH of the source - it needs solid at BOTTOM
 * to connect to the source tile below it.
 */
function generateTransitionImage(source: ImageData, direction: TransitionDirection): ImageData {
  const width = source.width;
  const height = source.height;
  const result = new ImageData(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = calculateTransitionAlpha(direction, x, y, width, height);

      // Copy RGB from source, apply calculated alpha
      result.data[idx] = source.data[idx];
      result.data[idx + 1] = source.data[idx + 1];
      result.data[idx + 2] = source.data[idx + 2];
      result.data[idx + 3] = Math.round((source.data[idx + 3] / 255) * alpha);
    }
  }

  return result;
}

/**
 * Calculate alpha value for a pixel based on transition direction.
 * Returns 0-255 alpha value.
 */
function calculateTransitionAlpha(
  direction: TransitionDirection,
  x: number, y: number,
  width: number, height: number
): number {
  switch (direction) {
    case 'n': return calcSouthAlpha(y, height);    // Solid at bottom (placed north)
    case 's': return calcNorthAlpha(y);             // Solid at top (placed south)
    case 'e': return calcWestAlpha(x);              // Solid at left (placed east)
    case 'w': return calcEastAlpha(x, width);       // Solid at right (placed west)
    case 'ne': return calcCornerAlpha(x, height - 1 - y);              // Solid at bottom-left
    case 'nw': return calcCornerAlpha(width - 1 - x, height - 1 - y);  // Solid at bottom-right
    case 'se': return calcCornerAlpha(x, y);                            // Solid at top-left
    case 'sw': return calcCornerAlpha(width - 1 - x, y);               // Solid at top-right
  }
}

function calcNorthAlpha(y: number): number {
  if (y < TRANSITION_SOLID_PIXELS) return 255;
  if (y < TRANSITION_SOLID_PIXELS + TRANSITION_FADE_PIXELS) {
    const fadeProgress = y - TRANSITION_SOLID_PIXELS;
    return 255 - Math.round(fadeProgress * 255 / TRANSITION_FADE_PIXELS);
  }
  return 0;
}

function calcSouthAlpha(y: number, height: number): number {
  const distFromBottom = height - 1 - y;
  if (distFromBottom < TRANSITION_SOLID_PIXELS) return 255;
  if (distFromBottom < TRANSITION_SOLID_PIXELS + TRANSITION_FADE_PIXELS) {
    const fadeProgress = distFromBottom - TRANSITION_SOLID_PIXELS;
    return 255 - Math.round(fadeProgress * 255 / TRANSITION_FADE_PIXELS);
  }
  return 0;
}

function calcEastAlpha(x: number, width: number): number {
  const distFromRight = width - 1 - x;
  if (distFromRight < TRANSITION_SOLID_PIXELS) return 255;
  if (distFromRight < TRANSITION_SOLID_PIXELS + TRANSITION_FADE_PIXELS) {
    const fadeProgress = distFromRight - TRANSITION_SOLID_PIXELS;
    return 255 - Math.round(fadeProgress * 255 / TRANSITION_FADE_PIXELS);
  }
  return 0;
}

function calcWestAlpha(x: number): number {
  if (x < TRANSITION_SOLID_PIXELS) return 255;
  if (x < TRANSITION_SOLID_PIXELS + TRANSITION_FADE_PIXELS) {
    const fadeProgress = x - TRANSITION_SOLID_PIXELS;
    return 255 - Math.round(fadeProgress * 255 / TRANSITION_FADE_PIXELS);
  }
  return 0;
}

function calcCornerAlpha(cornerDistX: number, cornerDistY: number): number {
  // Solid square corner
  if (cornerDistX < TRANSITION_SOLID_PIXELS && cornerDistY < TRANSITION_SOLID_PIXELS) {
    return 255;
  }
  // Circular fade from corner
  const distance = Math.sqrt(cornerDistX * cornerDistX + cornerDistY * cornerDistY);
  if (distance < TRANSITION_SOLID_PIXELS) return 255;
  if (distance < TRANSITION_SOLID_PIXELS + TRANSITION_FADE_PIXELS) {
    const fadeProgress = distance - TRANSITION_SOLID_PIXELS;
    return 255 - Math.round(fadeProgress * 255 / TRANSITION_FADE_PIXELS);
  }
  return 0;
}

export default TileEditor;
