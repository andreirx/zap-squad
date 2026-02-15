import {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import type { Color, Point, Selection, Tool, HistoryEntry } from './types';

/** Canvas ref methods exposed to parent */
export interface PixelCanvasRef {
  getImageData(): ImageData;
  setImageData(data: ImageData): void;
  clear(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  getDataUrl(format?: string): string;
  rotateClockwise(): void;
  rotateCounterClockwise(): void;
  flipHorizontal(): void;
  flipVertical(): void;
  copySelection(): ImageData | null;
  pasteSelection(data: ImageData): void;
  deleteSelection(): void;
}

export interface PixelCanvasProps {
  width: number;
  height: number;
  zoom?: number;
  tool?: Tool;
  color?: Color;
  backgroundColor?: Color;
  showGrid?: boolean;
  onColorPick?: (color: Color) => void;
  onChange?: (data: ImageData) => void;
}

const CHECKERBOARD_SIZE = 8;
const MAX_HISTORY = 50;

/** Full-featured pixel art canvas with tools and selection */
export const PixelCanvas = forwardRef<PixelCanvasRef, PixelCanvasProps>(
  function PixelCanvas(
    {
      width,
      height,
      zoom = 16,
      tool = 'pencil',
      color = { r: 0, g: 0, b: 0, a: 255 },
      backgroundColor = { r: 0, g: 0, b: 0, a: 0 },
      showGrid = true,
      onColorPick,
      onChange,
    },
    ref
  ) {
    // Canvas refs
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Image data
    const imageDataRef = useRef<ImageData | null>(null);

    // Drawing state
    const [isDrawing, setIsDrawing] = useState(false);
    const lastPointRef = useRef<Point | null>(null);

    // Selection state
    const [selection, setSelection] = useState<Selection | null>(null);
    const [selectionData, setSelectionData] = useState<ImageData | null>(null);
    const [isDraggingSelection, setIsDraggingSelection] = useState(false);
    const [isResizingSelection, setIsResizingSelection] = useState(false);
    const [resizeHandle, setResizeHandle] = useState<string | null>(null);
    const dragStartRef = useRef<Point | null>(null);
    const selectionStartRef = useRef<Selection | null>(null);

    // History for undo/redo
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);

    // Initialize canvas
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      // Create or resize image data
      if (
        !imageDataRef.current ||
        imageDataRef.current.width !== width ||
        imageDataRef.current.height !== height
      ) {
        const newData = ctx.createImageData(width, height);
        // Fill with background color
        for (let i = 0; i < newData.data.length; i += 4) {
          newData.data[i] = backgroundColor.r;
          newData.data[i + 1] = backgroundColor.g;
          newData.data[i + 2] = backgroundColor.b;
          newData.data[i + 3] = backgroundColor.a;
        }
        imageDataRef.current = newData;
        pushHistory(newData);
      }

      render();
    }, [width, height]);

    // Render canvas
    const render = useCallback(() => {
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      if (!canvas || !overlay || !imageDataRef.current) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const overlayCtx = overlay.getContext('2d');
      if (!ctx || !overlayCtx) return;

      // Draw checkerboard background for transparency
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawCheckerboard(ctx, width, height, zoom);

      // Draw image data scaled up
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) {
        tempCtx.putImageData(imageDataRef.current, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, width * zoom, height * zoom);
      }

      // Draw grid
      if (showGrid && zoom >= 4) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= width; x++) {
          ctx.beginPath();
          ctx.moveTo(x * zoom, 0);
          ctx.lineTo(x * zoom, height * zoom);
          ctx.stroke();
        }
        for (let y = 0; y <= height; y++) {
          ctx.beginPath();
          ctx.moveTo(0, y * zoom);
          ctx.lineTo(width * zoom, y * zoom);
          ctx.stroke();
        }
      }

      // Draw selection on overlay
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      if (selection) {
        drawSelection(overlayCtx, selection, zoom);
      }
    }, [width, height, zoom, showGrid, selection]);

    // Re-render on state changes
    useEffect(() => {
      render();
    }, [render, selection]);

    // Draw checkerboard pattern for transparency
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

    // Draw selection rectangle with handles
    function drawSelection(
      ctx: CanvasRenderingContext2D,
      sel: Selection,
      z: number
    ) {
      const x = sel.x * z;
      const y = sel.y * z;
      const w = sel.width * z;
      const h = sel.height * z;

      // Marching ants effect
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = 4;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;

      // Resize handles
      const handleSize = 6;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;

      const handles = [
        { name: 'nw', cx: x, cy: y },
        { name: 'n', cx: x + w / 2, cy: y },
        { name: 'ne', cx: x + w, cy: y },
        { name: 'e', cx: x + w, cy: y + h / 2 },
        { name: 'se', cx: x + w, cy: y + h },
        { name: 's', cx: x + w / 2, cy: y + h },
        { name: 'sw', cx: x, cy: y + h },
        { name: 'w', cx: x, cy: y + h / 2 },
      ];

      for (const handle of handles) {
        ctx.fillRect(
          handle.cx - handleSize / 2,
          handle.cy - handleSize / 2,
          handleSize,
          handleSize
        );
        ctx.strokeRect(
          handle.cx - handleSize / 2,
          handle.cy - handleSize / 2,
          handleSize,
          handleSize
        );
      }
    }

    // Push state to history
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

    // Get pixel coordinates from mouse event
    function getPixelCoords(e: React.MouseEvent): Point {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) / zoom);
      const y = Math.floor((e.clientY - rect.top) / zoom);
      return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)) };
    }

    // Get resize handle at point
    function getResizeHandle(p: Point, sel: Selection): string | null {
      const handleSize = 6 / zoom;
      const handles: { name: string; x: number; y: number }[] = [
        { name: 'nw', x: sel.x, y: sel.y },
        { name: 'n', x: sel.x + sel.width / 2, y: sel.y },
        { name: 'ne', x: sel.x + sel.width, y: sel.y },
        { name: 'e', x: sel.x + sel.width, y: sel.y + sel.height / 2 },
        { name: 'se', x: sel.x + sel.width, y: sel.y + sel.height },
        { name: 's', x: sel.x + sel.width / 2, y: sel.y + sel.height },
        { name: 'sw', x: sel.x, y: sel.y + sel.height },
        { name: 'w', x: sel.x, y: sel.y + sel.height / 2 },
      ];

      for (const handle of handles) {
        if (
          Math.abs(p.x - handle.x) <= handleSize &&
          Math.abs(p.y - handle.y) <= handleSize
        ) {
          return handle.name;
        }
      }
      return null;
    }

    // Check if point is inside selection
    function isInsideSelection(p: Point, sel: Selection): boolean {
      return (
        p.x >= sel.x &&
        p.x < sel.x + sel.width &&
        p.y >= sel.y &&
        p.y < sel.y + sel.height
      );
    }

    // Set pixel color
    function setPixel(x: number, y: number, c: Color) {
      if (!imageDataRef.current) return;
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      const i = (y * width + x) * 4;
      imageDataRef.current.data[i] = c.r;
      imageDataRef.current.data[i + 1] = c.g;
      imageDataRef.current.data[i + 2] = c.b;
      imageDataRef.current.data[i + 3] = c.a;
    }

    // Get pixel color
    function getPixel(x: number, y: number): Color {
      if (!imageDataRef.current) return { r: 0, g: 0, b: 0, a: 0 };
      if (x < 0 || x >= width || y < 0 || y >= height) return { r: 0, g: 0, b: 0, a: 0 };
      const i = (y * width + x) * 4;
      return {
        r: imageDataRef.current.data[i],
        g: imageDataRef.current.data[i + 1],
        b: imageDataRef.current.data[i + 2],
        a: imageDataRef.current.data[i + 3],
      };
    }

    // Draw line between two points (Bresenham)
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
        if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) continue;

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

    // Compare colors
    function colorsEqual(a: Color, b: Color): boolean {
      return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
    }

    // Mouse event handlers
    function handleMouseDown(e: React.MouseEvent) {
      const p = getPixelCoords(e);

      if (tool === 'select') {
        if (selection) {
          const handle = getResizeHandle(p, selection);
          if (handle) {
            setIsResizingSelection(true);
            setResizeHandle(handle);
            dragStartRef.current = p;
            selectionStartRef.current = { ...selection };
            return;
          }
          if (isInsideSelection(p, selection)) {
            setIsDraggingSelection(true);
            dragStartRef.current = p;
            selectionStartRef.current = { ...selection };
            // Extract selection data if not already extracted
            if (!selectionData && imageDataRef.current) {
              const data = extractSelectionData(selection);
              setSelectionData(data);
            }
            return;
          }
          // Clicking outside clears selection and commits it
          commitSelection();
        }
        // Start new selection
        setSelection({ x: p.x, y: p.y, width: 1, height: 1 });
        setSelectionData(null);
        setIsDrawing(true);
        dragStartRef.current = p;
        return;
      }

      if (tool === 'eyedropper') {
        const pickedColor = getPixel(p.x, p.y);
        onColorPick?.(pickedColor);
        return;
      }

      // Drawing tools
      setIsDrawing(true);
      lastPointRef.current = p;

      if (tool === 'pencil') {
        setPixel(p.x, p.y, color);
      } else if (tool === 'eraser') {
        setPixel(p.x, p.y, backgroundColor);
      } else if (tool === 'fill') {
        floodFill(p.x, p.y, color);
        pushHistory(imageDataRef.current!);
        onChange?.(imageDataRef.current!);
      } else if (tool === 'line') {
        // Line tool just records start point
      }

      render();
    }

    function handleMouseMove(e: React.MouseEvent) {
      const p = getPixelCoords(e);

      // Update cursor based on context
      const container = containerRef.current;
      if (container) {
        if (tool === 'select' && selection) {
          const handle = getResizeHandle(p, selection);
          if (handle) {
            const cursors: Record<string, string> = {
              nw: 'nwse-resize',
              ne: 'nesw-resize',
              se: 'nwse-resize',
              sw: 'nesw-resize',
              n: 'ns-resize',
              s: 'ns-resize',
              e: 'ew-resize',
              w: 'ew-resize',
            };
            container.style.cursor = cursors[handle];
          } else if (isInsideSelection(p, selection)) {
            container.style.cursor = 'move';
          } else {
            container.style.cursor = 'crosshair';
          }
        } else {
          container.style.cursor = tool === 'eyedropper' ? 'crosshair' : 'default';
        }
      }

      if (!isDrawing && !isDraggingSelection && !isResizingSelection) return;

      if (isResizingSelection && selection && dragStartRef.current && selectionStartRef.current) {
        const dx = p.x - dragStartRef.current.x;
        const dy = p.y - dragStartRef.current.y;
        const sel = { ...selectionStartRef.current };

        switch (resizeHandle) {
          case 'nw':
            sel.x += dx;
            sel.y += dy;
            sel.width -= dx;
            sel.height -= dy;
            break;
          case 'n':
            sel.y += dy;
            sel.height -= dy;
            break;
          case 'ne':
            sel.y += dy;
            sel.width += dx;
            sel.height -= dy;
            break;
          case 'e':
            sel.width += dx;
            break;
          case 'se':
            sel.width += dx;
            sel.height += dy;
            break;
          case 's':
            sel.height += dy;
            break;
          case 'sw':
            sel.x += dx;
            sel.width -= dx;
            sel.height += dy;
            break;
          case 'w':
            sel.x += dx;
            sel.width -= dx;
            break;
        }

        // Ensure minimum size
        if (sel.width >= 1 && sel.height >= 1) {
          setSelection(sel);
        }
        return;
      }

      if (isDraggingSelection && selection && dragStartRef.current && selectionStartRef.current) {
        const dx = p.x - dragStartRef.current.x;
        const dy = p.y - dragStartRef.current.y;
        setSelection({
          ...selection,
          x: selectionStartRef.current.x + dx,
          y: selectionStartRef.current.y + dy,
        });
        return;
      }

      if (tool === 'select' && dragStartRef.current) {
        const minX = Math.min(dragStartRef.current.x, p.x);
        const minY = Math.min(dragStartRef.current.y, p.y);
        const maxX = Math.max(dragStartRef.current.x, p.x);
        const maxY = Math.max(dragStartRef.current.y, p.y);
        setSelection({
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        });
        return;
      }

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

    function handleMouseUp(e: React.MouseEvent) {
      const p = getPixelCoords(e);

      if (isResizingSelection) {
        setIsResizingSelection(false);
        setResizeHandle(null);
        dragStartRef.current = null;
        selectionStartRef.current = null;
        return;
      }

      if (isDraggingSelection) {
        setIsDraggingSelection(false);
        dragStartRef.current = null;
        selectionStartRef.current = null;
        return;
      }

      if (tool === 'line' && isDrawing && lastPointRef.current) {
        drawLine(lastPointRef.current, p, color);
        pushHistory(imageDataRef.current!);
        onChange?.(imageDataRef.current!);
        render();
      }

      if (isDrawing && (tool === 'pencil' || tool === 'eraser')) {
        pushHistory(imageDataRef.current!);
        onChange?.(imageDataRef.current!);
      }

      if (tool === 'select' && isDrawing && selection) {
        // Selection created, extract data
        const data = extractSelectionData(selection);
        setSelectionData(data);
      }

      setIsDrawing(false);
      lastPointRef.current = null;
    }

    function handleMouseLeave() {
      if (isDrawing && (tool === 'pencil' || tool === 'eraser')) {
        pushHistory(imageDataRef.current!);
        onChange?.(imageDataRef.current!);
      }
      setIsDrawing(false);
      lastPointRef.current = null;
    }

    // Extract selection data from image
    function extractSelectionData(sel: Selection): ImageData {
      const canvas = document.createElement('canvas');
      canvas.width = sel.width;
      canvas.height = sel.height;
      const ctx = canvas.getContext('2d')!;
      const data = ctx.createImageData(sel.width, sel.height);

      for (let y = 0; y < sel.height; y++) {
        for (let x = 0; x < sel.width; x++) {
          const srcX = sel.x + x;
          const srcY = sel.y + y;
          if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
            const srcColor = getPixel(srcX, srcY);
            const dstI = (y * sel.width + x) * 4;
            data.data[dstI] = srcColor.r;
            data.data[dstI + 1] = srcColor.g;
            data.data[dstI + 2] = srcColor.b;
            data.data[dstI + 3] = srcColor.a;
          }
        }
      }

      return data;
    }

    // Commit selection back to image
    function commitSelection() {
      if (!selection || !selectionData || !imageDataRef.current) {
        setSelection(null);
        setSelectionData(null);
        return;
      }

      // Clear original selection area (if moved)
      // Then paste selection data at new position
      for (let y = 0; y < selection.height; y++) {
        for (let x = 0; x < selection.width; x++) {
          // Scale if selection was resized
          const srcX = Math.floor((x / selection.width) * selectionData.width);
          const srcY = Math.floor((y / selection.height) * selectionData.height);
          const srcI = (srcY * selectionData.width + srcX) * 4;

          const dstX = selection.x + x;
          const dstY = selection.y + y;
          if (dstX >= 0 && dstX < width && dstY >= 0 && dstY < height) {
            setPixel(dstX, dstY, {
              r: selectionData.data[srcI],
              g: selectionData.data[srcI + 1],
              b: selectionData.data[srcI + 2],
              a: selectionData.data[srcI + 3],
            });
          }
        }
      }

      pushHistory(imageDataRef.current);
      onChange?.(imageDataRef.current);
      setSelection(null);
      setSelectionData(null);
      render();
    }

    // Imperative handle for parent component
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
      clear() {
        if (!imageDataRef.current) return;
        for (let i = 0; i < imageDataRef.current.data.length; i += 4) {
          imageDataRef.current.data[i] = backgroundColor.r;
          imageDataRef.current.data[i + 1] = backgroundColor.g;
          imageDataRef.current.data[i + 2] = backgroundColor.b;
          imageDataRef.current.data[i + 3] = backgroundColor.a;
        }
        pushHistory(imageDataRef.current);
        onChange?.(imageDataRef.current);
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
        onChange?.(imageDataRef.current);
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
        onChange?.(imageDataRef.current);
        render();
      },
      canUndo() {
        return historyIndex > 0;
      },
      canRedo() {
        return historyIndex < history.length - 1;
      },
      getDataUrl(format = 'image/png'): string {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const ctx = tempCanvas.getContext('2d')!;
        ctx.putImageData(imageDataRef.current!, 0, 0);
        return tempCanvas.toDataURL(format);
      },
      rotateClockwise() {
        if (!imageDataRef.current) return;
        const oldData = imageDataRef.current;
        const newData = new ImageData(oldData.height, oldData.width);
        for (let y = 0; y < oldData.height; y++) {
          for (let x = 0; x < oldData.width; x++) {
            const srcI = (y * oldData.width + x) * 4;
            const dstX = oldData.height - 1 - y;
            const dstY = x;
            const dstI = (dstY * newData.width + dstX) * 4;
            newData.data[dstI] = oldData.data[srcI];
            newData.data[dstI + 1] = oldData.data[srcI + 1];
            newData.data[dstI + 2] = oldData.data[srcI + 2];
            newData.data[dstI + 3] = oldData.data[srcI + 3];
          }
        }
        imageDataRef.current = newData;
        pushHistory(newData);
        onChange?.(newData);
        render();
      },
      rotateCounterClockwise() {
        if (!imageDataRef.current) return;
        const oldData = imageDataRef.current;
        const newData = new ImageData(oldData.height, oldData.width);
        for (let y = 0; y < oldData.height; y++) {
          for (let x = 0; x < oldData.width; x++) {
            const srcI = (y * oldData.width + x) * 4;
            const dstX = y;
            const dstY = oldData.width - 1 - x;
            const dstI = (dstY * newData.width + dstX) * 4;
            newData.data[dstI] = oldData.data[srcI];
            newData.data[dstI + 1] = oldData.data[srcI + 1];
            newData.data[dstI + 2] = oldData.data[srcI + 2];
            newData.data[dstI + 3] = oldData.data[srcI + 3];
          }
        }
        imageDataRef.current = newData;
        pushHistory(newData);
        onChange?.(newData);
        render();
      },
      flipHorizontal() {
        if (!imageDataRef.current) return;
        const data = imageDataRef.current;
        const newData = new ImageData(
          new Uint8ClampedArray(data.data),
          data.width,
          data.height
        );
        for (let y = 0; y < data.height; y++) {
          for (let x = 0; x < data.width; x++) {
            const srcI = (y * data.width + x) * 4;
            const dstX = data.width - 1 - x;
            const dstI = (y * data.width + dstX) * 4;
            newData.data[dstI] = data.data[srcI];
            newData.data[dstI + 1] = data.data[srcI + 1];
            newData.data[dstI + 2] = data.data[srcI + 2];
            newData.data[dstI + 3] = data.data[srcI + 3];
          }
        }
        imageDataRef.current = newData;
        pushHistory(newData);
        onChange?.(newData);
        render();
      },
      flipVertical() {
        if (!imageDataRef.current) return;
        const data = imageDataRef.current;
        const newData = new ImageData(
          new Uint8ClampedArray(data.data),
          data.width,
          data.height
        );
        for (let y = 0; y < data.height; y++) {
          for (let x = 0; x < data.width; x++) {
            const srcI = (y * data.width + x) * 4;
            const dstY = data.height - 1 - y;
            const dstI = (dstY * data.width + x) * 4;
            newData.data[dstI] = data.data[srcI];
            newData.data[dstI + 1] = data.data[srcI + 1];
            newData.data[dstI + 2] = data.data[srcI + 2];
            newData.data[dstI + 3] = data.data[srcI + 3];
          }
        }
        imageDataRef.current = newData;
        pushHistory(newData);
        onChange?.(newData);
        render();
      },
      copySelection(): ImageData | null {
        if (!selection) return null;
        return extractSelectionData(selection);
      },
      pasteSelection(data: ImageData) {
        setSelection({ x: 0, y: 0, width: data.width, height: data.height });
        setSelectionData(data);
        render();
      },
      deleteSelection() {
        if (!selection || !imageDataRef.current) return;
        for (let y = selection.y; y < selection.y + selection.height; y++) {
          for (let x = selection.x; x < selection.x + selection.width; x++) {
            if (x >= 0 && x < width && y >= 0 && y < height) {
              setPixel(x, y, backgroundColor);
            }
          }
        }
        pushHistory(imageDataRef.current);
        onChange?.(imageDataRef.current);
        setSelection(null);
        setSelectionData(null);
        render();
      },
    }));

    // Keyboard shortcuts
    useEffect(() => {
      function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selection && containerRef.current?.contains(document.activeElement)) {
            e.preventDefault();
            const canvasRef_ = ref as React.RefObject<PixelCanvasRef>;
            canvasRef_.current?.deleteSelection();
          }
        }
      }
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selection, ref]);

    return (
      <div
        ref={containerRef}
        tabIndex={0}
        style={{
          position: 'relative',
          width: width * zoom,
          height: height * zoom,
          outline: 'none',
        }}
      >
        <canvas
          ref={canvasRef}
          width={width * zoom}
          height={height * zoom}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            imageRendering: 'pixelated',
          }}
        />
        <canvas
          ref={overlayRef}
          width={width * zoom}
          height={height * zoom}
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
            width: width * zoom,
            height: height * zoom,
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

export default PixelCanvas;
