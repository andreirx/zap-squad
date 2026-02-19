import {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import type { Color, Point, Tool } from './types';
import type {
  AtlasSchema,
  CharacterAtlasSchema,
  TileAtlasSchema,
  WeaponAtlasSchema,
  AtlasCell,
} from '../types/atlas';
import {
  getCharacterCellAt,
  getTileCellAt,
  getWeaponCellAt,
} from '../types/atlas';

// ============================================================================
// Types
// ============================================================================

export interface SpriteSheetEditorRef {
  getImageData(): ImageData;
  setImageData(data: ImageData): void;
  getAtlasDataUrl(): string;
  getCellImageData(row: number, col: number): ImageData;
  setCellImageData(row: number, col: number, data: ImageData): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export interface SpriteSheetEditorProps {
  schema: AtlasSchema;
  atlasUrl?: string; // Initial atlas image URL to load
  zoom?: number;
  tool?: Tool;
  color?: Color;
  backgroundColor?: Color;
  showGrid?: boolean;
  selectedCell?: { row: number; col: number } | null;
  onCellSelect?: (cell: AtlasCell | null) => void;
  onCellHover?: (cell: AtlasCell | null) => void;
  onChange?: () => void;
}

interface HistoryEntry {
  data: ImageData;
  timestamp: number;
}

const MAX_HISTORY = 30;
const CHECKERBOARD_SIZE = 8;

// ============================================================================
// Component
// ============================================================================

export const SpriteSheetEditor = forwardRef<SpriteSheetEditorRef, SpriteSheetEditorProps>(
  function SpriteSheetEditor(
    {
      schema,
      atlasUrl,
      zoom = 4,
      tool = 'pencil',
      color = { r: 0, g: 0, b: 0, a: 255 },
      backgroundColor = { r: 0, g: 0, b: 0, a: 0 },
      showGrid = true,
      selectedCell,
      onCellSelect,
      onCellHover,
      onChange,
    },
    ref
  ) {
    // Canvas refs
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Image data (full atlas)
    const imageDataRef = useRef<ImageData | null>(null);

    // Drawing state
    const [isDrawing, setIsDrawing] = useState(false);
    const lastPointRef = useRef<Point | null>(null);

    // History
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);

    // Computed dimensions
    const atlasWidth = schema.columns * schema.spriteSize;
    const atlasHeight = schema.rows.length * schema.spriteSize;

    // Initialize canvas with empty or loaded image
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      async function init() {
        if (atlasUrl) {
          // Load existing atlas
          try {
            const img = await loadImage(atlasUrl);
            const data = imageToImageData(img, img.width, img.height);
            imageDataRef.current = data;
            pushHistory(data);
          } catch (e) {
            console.warn('Failed to load atlas, creating empty:', e);
            createEmptyAtlas();
          }
        } else {
          createEmptyAtlas();
        }
        render();
      }

      function createEmptyAtlas() {
        const data = ctx!.createImageData(atlasWidth, atlasHeight);
        // Fill with transparent background
        for (let i = 0; i < data.data.length; i += 4) {
          data.data[i] = backgroundColor.r;
          data.data[i + 1] = backgroundColor.g;
          data.data[i + 2] = backgroundColor.b;
          data.data[i + 3] = backgroundColor.a;
        }
        imageDataRef.current = data;
        pushHistory(data);
      }

      init();
    }, [atlasUrl, atlasWidth, atlasHeight]);

    // Push to history
    function pushHistory(data: ImageData) {
      const copy = new ImageData(
        new Uint8ClampedArray(data.data),
        data.width,
        data.height
      );
      setHistory((prev) => {
        const newHistory = prev.slice(0, historyIndex + 1);
        newHistory.push({ data: copy, timestamp: Date.now() });
        if (newHistory.length > MAX_HISTORY) {
          newHistory.shift();
        }
        return newHistory;
      });
      setHistoryIndex((prev) => Math.min(prev + 1, MAX_HISTORY - 1));
    }

    // Render canvas
    const render = useCallback(() => {
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      if (!canvas || !overlay || !imageDataRef.current) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const overlayCtx = overlay.getContext('2d');
      if (!ctx || !overlayCtx) return;

      // Draw checkerboard background
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawCheckerboard(ctx, atlasWidth, atlasHeight, zoom);

      // Draw image data scaled up
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = imageDataRef.current.width;
      tempCanvas.height = imageDataRef.current.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) {
        tempCtx.putImageData(imageDataRef.current, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          tempCanvas,
          0,
          0,
          imageDataRef.current.width * zoom,
          imageDataRef.current.height * zoom
        );
      }

      // Draw grid overlay
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

      if (showGrid) {
        const spriteSize = schema.spriteSize;

        // Draw cell grid
        overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        overlayCtx.lineWidth = 1;

        for (let col = 0; col <= schema.columns; col++) {
          overlayCtx.beginPath();
          overlayCtx.moveTo(col * spriteSize * zoom, 0);
          overlayCtx.lineTo(col * spriteSize * zoom, atlasHeight * zoom);
          overlayCtx.stroke();
        }

        for (let row = 0; row <= schema.rows.length; row++) {
          overlayCtx.beginPath();
          overlayCtx.moveTo(0, row * spriteSize * zoom);
          overlayCtx.lineTo(atlasWidth * zoom, row * spriteSize * zoom);
          overlayCtx.stroke();
        }

        // Highlight selected cell
        if (selectedCell) {
          overlayCtx.strokeStyle = '#4ecca3';
          overlayCtx.lineWidth = 3;
          overlayCtx.strokeRect(
            selectedCell.col * spriteSize * zoom,
            selectedCell.row * spriteSize * zoom,
            spriteSize * zoom,
            spriteSize * zoom
          );
        }

        // Draw row labels
        overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        overlayCtx.font = `${Math.min(12, spriteSize * zoom * 0.15)}px monospace`;
        overlayCtx.textBaseline = 'top';

        for (let row = 0; row < schema.rows.length; row++) {
          const label = getRowLabel(schema, row);
          const textWidth = overlayCtx.measureText(label).width;

          overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          overlayCtx.fillRect(
            2,
            row * spriteSize * zoom + 2,
            textWidth + 4,
            14
          );

          overlayCtx.fillStyle = '#fff';
          overlayCtx.fillText(label, 4, row * spriteSize * zoom + 3);
        }
      }
    }, [schema, atlasWidth, atlasHeight, zoom, showGrid, selectedCell]);

    // Re-render on state changes
    useEffect(() => {
      render();
    }, [render]);

    // Get cell at pixel position
    function getCellAt(x: number, y: number): AtlasCell | null {
      switch (schema.type) {
        case 'character':
          return getCharacterCellAt(schema as CharacterAtlasSchema, x, y);
        case 'tile':
          return getTileCellAt(schema as TileAtlasSchema, x, y);
        case 'weapon':
          return getWeaponCellAt(schema as WeaponAtlasSchema, x, y);
        default:
          return null;
      }
    }

    // Get pixel coordinates from mouse event
    function getPixelCoords(e: React.MouseEvent): Point {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) / zoom);
      const y = Math.floor((e.clientY - rect.top) / zoom);
      return {
        x: Math.max(0, Math.min(atlasWidth - 1, x)),
        y: Math.max(0, Math.min(atlasHeight - 1, y)),
      };
    }

    // Set pixel color
    function setPixel(x: number, y: number, c: Color) {
      if (!imageDataRef.current) return;
      if (x < 0 || x >= atlasWidth || y < 0 || y >= atlasHeight) return;
      const i = (y * atlasWidth + x) * 4;
      imageDataRef.current.data[i] = c.r;
      imageDataRef.current.data[i + 1] = c.g;
      imageDataRef.current.data[i + 2] = c.b;
      imageDataRef.current.data[i + 3] = c.a;
    }

    // Get pixel color
    function getPixel(x: number, y: number): Color {
      if (!imageDataRef.current) return { r: 0, g: 0, b: 0, a: 0 };
      if (x < 0 || x >= atlasWidth || y < 0 || y >= atlasHeight) {
        return { r: 0, g: 0, b: 0, a: 0 };
      }
      const i = (y * atlasWidth + x) * 4;
      return {
        r: imageDataRef.current.data[i],
        g: imageDataRef.current.data[i + 1],
        b: imageDataRef.current.data[i + 2],
        a: imageDataRef.current.data[i + 3],
      };
    }

    // Draw line (Bresenham)
    function drawLine(p1: Point, p2: Point, c: Color) {
      const dx = Math.abs(p2.x - p1.x);
      const dy = Math.abs(p2.y - p1.y);
      const sx = p1.x < p2.x ? 1 : -1;
      const sy = p1.y < p2.y ? 1 : -1;
      let err = dx - dy;
      let x = p1.x;
      let y = p1.y;

      while (true) {
        setPixel(x, y, c);
        if (x === p2.x && y === p2.y) break;
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
    }

    // Flood fill
    function floodFill(startX: number, startY: number, fillColor: Color) {
      if (!imageDataRef.current) return;

      const targetColor = getPixel(startX, startY);
      if (colorsEqual(targetColor, fillColor)) return;

      const stack: Point[] = [{ x: startX, y: startY }];
      const visited = new Set<string>();

      while (stack.length > 0) {
        const p = stack.pop()!;
        const key = `${p.x},${p.y}`;
        if (visited.has(key)) continue;
        if (p.x < 0 || p.x >= atlasWidth || p.y < 0 || p.y >= atlasHeight) continue;

        const currentColor = getPixel(p.x, p.y);
        if (!colorsEqual(currentColor, targetColor)) continue;

        visited.add(key);
        setPixel(p.x, p.y, fillColor);

        stack.push({ x: p.x + 1, y: p.y });
        stack.push({ x: p.x - 1, y: p.y });
        stack.push({ x: p.x, y: p.y + 1 });
        stack.push({ x: p.x, y: p.y - 1 });
      }
    }

    function colorsEqual(a: Color, b: Color): boolean {
      return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
    }

    // Mouse handlers
    function handleMouseDown(e: React.MouseEvent) {
      const p = getPixelCoords(e);
      const cell = getCellAt(p.x, p.y);

      // Cell selection on click
      if (cell) {
        onCellSelect?.(cell);
      }

      if (tool === 'eyedropper') {
        return;
      }

      setIsDrawing(true);
      lastPointRef.current = p;

      if (tool === 'pencil') {
        setPixel(p.x, p.y, color);
      } else if (tool === 'eraser') {
        setPixel(p.x, p.y, backgroundColor);
      } else if (tool === 'fill') {
        floodFill(p.x, p.y, color);
        pushHistory(imageDataRef.current!);
        onChange?.();
      }

      render();
    }

    function handleMouseMove(e: React.MouseEvent) {
      const p = getPixelCoords(e);
      const cell = getCellAt(p.x, p.y);
      onCellHover?.(cell);

      if (!isDrawing) return;

      if (tool === 'pencil' && lastPointRef.current) {
        drawLine(lastPointRef.current, p, color);
        lastPointRef.current = p;
        render();
      } else if (tool === 'eraser' && lastPointRef.current) {
        drawLine(lastPointRef.current, p, backgroundColor);
        lastPointRef.current = p;
        render();
      }
    }

    function handleMouseUp() {
      if (isDrawing && (tool === 'pencil' || tool === 'eraser')) {
        pushHistory(imageDataRef.current!);
        onChange?.();
      }
      setIsDrawing(false);
      lastPointRef.current = null;
    }

    function handleMouseLeave() {
      onCellHover?.(null);
      if (isDrawing && (tool === 'pencil' || tool === 'eraser')) {
        pushHistory(imageDataRef.current!);
        onChange?.();
      }
      setIsDrawing(false);
      lastPointRef.current = null;
    }

    // Imperative handle
    useImperativeHandle(ref, () => ({
      getImageData(): ImageData {
        return imageDataRef.current!;
      },
      setImageData(data: ImageData) {
        imageDataRef.current = new ImageData(
          new Uint8ClampedArray(data.data),
          data.width,
          data.height
        );
        pushHistory(imageDataRef.current);
        render();
      },
      getAtlasDataUrl(): string {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = atlasWidth;
        tempCanvas.height = atlasHeight;
        const ctx = tempCanvas.getContext('2d')!;
        ctx.putImageData(imageDataRef.current!, 0, 0);
        return tempCanvas.toDataURL('image/png');
      },
      getCellImageData(row: number, col: number): ImageData {
        const spriteSize = schema.spriteSize;
        const data = new ImageData(spriteSize, spriteSize);

        for (let y = 0; y < spriteSize; y++) {
          for (let x = 0; x < spriteSize; x++) {
            const srcX = col * spriteSize + x;
            const srcY = row * spriteSize + y;
            const srcColor = getPixel(srcX, srcY);
            const dstI = (y * spriteSize + x) * 4;
            data.data[dstI] = srcColor.r;
            data.data[dstI + 1] = srcColor.g;
            data.data[dstI + 2] = srcColor.b;
            data.data[dstI + 3] = srcColor.a;
          }
        }

        return data;
      },
      setCellImageData(row: number, col: number, data: ImageData) {
        const spriteSize = schema.spriteSize;

        for (let y = 0; y < Math.min(data.height, spriteSize); y++) {
          for (let x = 0; x < Math.min(data.width, spriteSize); x++) {
            const srcI = (y * data.width + x) * 4;
            const dstX = col * spriteSize + x;
            const dstY = row * spriteSize + y;
            setPixel(dstX, dstY, {
              r: data.data[srcI],
              g: data.data[srcI + 1],
              b: data.data[srcI + 2],
              a: data.data[srcI + 3],
            });
          }
        }

        pushHistory(imageDataRef.current!);
        onChange?.();
        render();
      },
      undo() {
        if (historyIndex <= 0) return;
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        imageDataRef.current = new ImageData(
          new Uint8ClampedArray(history[newIndex].data.data),
          history[newIndex].data.width,
          history[newIndex].data.height
        );
        onChange?.();
        render();
      },
      redo() {
        if (historyIndex >= history.length - 1) return;
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        imageDataRef.current = new ImageData(
          new Uint8ClampedArray(history[newIndex].data.data),
          history[newIndex].data.width,
          history[newIndex].data.height
        );
        onChange?.();
        render();
      },
      canUndo() {
        return historyIndex > 0;
      },
      canRedo() {
        return historyIndex < history.length - 1;
      },
    }));

    return (
      <div
        ref={containerRef}
        tabIndex={0}
        style={{
          position: 'relative',
          width: atlasWidth * zoom,
          height: atlasHeight * zoom,
          outline: 'none',
        }}
      >
        <canvas
          ref={canvasRef}
          width={atlasWidth * zoom}
          height={atlasHeight * zoom}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            imageRendering: 'pixelated',
          }}
        />
        <canvas
          ref={overlayRef}
          width={atlasWidth * zoom}
          height={atlasHeight * zoom}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: atlasWidth * zoom,
            height: atlasHeight * zoom,
            cursor: tool === 'eyedropper' ? 'crosshair' : 'default',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    );
  }
);

// ============================================================================
// Helpers
// ============================================================================

function drawCheckerboard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  z: number
) {
  const checkSize = CHECKERBOARD_SIZE;
  for (let y = 0; y < h * z; y += checkSize) {
    for (let x = 0; x < w * z; x += checkSize) {
      const isLight = ((x / checkSize) + (y / checkSize)) % 2 === 0;
      ctx.fillStyle = isLight ? '#444' : '#333';
      ctx.fillRect(x, y, checkSize, checkSize);
    }
  }
}

function getRowLabel(schema: AtlasSchema, row: number): string {
  const rowInfo = schema.rows[row];
  if (!rowInfo) return `Row ${row}`;

  switch (schema.type) {
    case 'character': {
      const charRow = rowInfo as { animation: string };
      return charRow.animation;
    }
    case 'tile': {
      const tileRow = rowInfo as { type: string; transition?: string };
      return tileRow.type === 'base' ? 'base' : `trans_${tileRow.transition}`;
    }
    case 'weapon': {
      const weaponRow = rowInfo as { animation: string };
      return weaponRow.animation;
    }
    default:
      return `Row ${row}`;
  }
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

export default SpriteSheetEditor;
