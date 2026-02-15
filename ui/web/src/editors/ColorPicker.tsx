import { useState, useCallback, useRef, useEffect } from 'react';
import type { Color } from './types';

export interface ColorPickerProps {
  color: Color;
  onChange: (color: Color) => void;
  recentColors?: Color[];
  onAddRecent?: (color: Color) => void;
}

/** Convert HSV to RGB */
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

/** Convert RGB to HSV */
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  return { h, s, v };
}

/** Convert color to hex string */
function colorToHex(color: Color): string {
  const r = color.r.toString(16).padStart(2, '0');
  const g = color.g.toString(16).padStart(2, '0');
  const b = color.b.toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/** Parse hex string to color */
function hexToColor(hex: string): Color | null {
  const match = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
    a: 255,
  };
}

/** Color picker with HSV wheel, alpha, and palette */
export function ColorPicker({ color, onChange, recentColors = [], onAddRecent }: ColorPickerProps) {
  const { h, s, v } = rgbToHsv(color.r, color.g, color.b);

  const [hue, setHue] = useState(h);
  const [sat, setSat] = useState(s);
  const [val, setVal] = useState(v);
  const [alpha, setAlpha] = useState(color.a / 255);
  const [hexInput, setHexInput] = useState(colorToHex(color));

  const svCanvasRef = useRef<HTMLCanvasElement>(null);
  const hueCanvasRef = useRef<HTMLCanvasElement>(null);

  // Update internal state when external color changes
  useEffect(() => {
    const { h, s, v } = rgbToHsv(color.r, color.g, color.b);
    setHue(h);
    setSat(s);
    setVal(v);
    setAlpha(color.a / 255);
    setHexInput(colorToHex(color));
  }, [color.r, color.g, color.b, color.a]);

  // Draw saturation/value canvas
  useEffect(() => {
    const canvas = svCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Draw gradient
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = x / width;
        const v = 1 - y / height;
        const rgb = hsvToRgb(hue, s, v);
        ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // Draw cursor
    const cursorX = sat * width;
    const cursorY = (1 - val) * height;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cursorX, cursorY, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cursorX, cursorY, 7, 0, Math.PI * 2);
    ctx.stroke();
  }, [hue, sat, val]);

  // Draw hue bar
  useEffect(() => {
    const canvas = hueCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Draw hue gradient
    for (let x = 0; x < width; x++) {
      const h = x / width;
      const rgb = hsvToRgb(h, 1, 1);
      ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
      ctx.fillRect(x, 0, 1, height);
    }

    // Draw cursor
    const cursorX = hue * width;
    ctx.fillStyle = '#fff';
    ctx.fillRect(cursorX - 2, 0, 4, height);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(cursorX - 2, 0, 4, height);
  }, [hue]);

  // Update color from HSV
  const updateColor = useCallback((h: number, s: number, v: number, a: number) => {
    const rgb = hsvToRgb(h, s, v);
    onChange({
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      a: Math.round(a * 255),
    });
  }, [onChange]);

  // SV canvas mouse handlers
  const handleSVMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = svCanvasRef.current;
    if (!canvas) return;

    const updateSV = (e: MouseEvent | React.MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      setSat(x);
      setVal(1 - y);
      updateColor(hue, x, 1 - y, alpha);
    };

    updateSV(e);

    const handleMouseMove = (e: MouseEvent) => updateSV(e);
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      onAddRecent?.(color);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [hue, alpha, updateColor, onAddRecent, color]);

  // Hue bar mouse handlers
  const handleHueMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = hueCanvasRef.current;
    if (!canvas) return;

    const updateH = (e: MouseEvent | React.MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHue(x);
      updateColor(x, sat, val, alpha);
    };

    updateH(e);

    const handleMouseMove = (e: MouseEvent) => updateH(e);
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sat, val, alpha, updateColor]);

  // Hex input handler
  const handleHexChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHexInput(value);
    const parsed = hexToColor(value);
    if (parsed) {
      onChange({ ...parsed, a: color.a });
    }
  }, [onChange, color.a]);

  // Alpha slider handler
  const handleAlphaChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const a = parseFloat(e.target.value);
    setAlpha(a);
    updateColor(hue, sat, val, a);
  }, [hue, sat, val, updateColor]);

  return (
    <div style={{ padding: '0.5rem', background: '#1a1a2e', borderRadius: '4px' }}>
      {/* Saturation/Value canvas */}
      <canvas
        ref={svCanvasRef}
        width={200}
        height={150}
        style={{ cursor: 'crosshair', borderRadius: '4px', display: 'block' }}
        onMouseDown={handleSVMouseDown}
      />

      {/* Hue bar */}
      <canvas
        ref={hueCanvasRef}
        width={200}
        height={16}
        style={{ cursor: 'ew-resize', borderRadius: '4px', marginTop: '0.5rem', display: 'block' }}
        onMouseDown={handleHueMouseDown}
      />

      {/* Alpha slider */}
      <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label style={{ color: '#888', fontSize: '0.75rem' }}>A:</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={alpha}
          onChange={handleAlphaChange}
          style={{ flex: 1 }}
        />
        <span style={{ color: '#ccc', fontSize: '0.75rem', width: '2rem' }}>
          {Math.round(alpha * 100)}%
        </span>
      </div>

      {/* Hex input */}
      <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label style={{ color: '#888', fontSize: '0.75rem' }}>Hex:</label>
        <input
          type="text"
          value={hexInput}
          onChange={handleHexChange}
          style={{
            flex: 1,
            background: '#0f0f23',
            border: '1px solid #333',
            borderRadius: '4px',
            padding: '0.25rem 0.5rem',
            color: '#ccc',
            fontSize: '0.875rem',
            fontFamily: 'monospace',
          }}
        />
        <div
          style={{
            width: 24,
            height: 24,
            background: `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`,
            border: '1px solid #333',
            borderRadius: '4px',
          }}
        />
      </div>

      {/* Recent colors */}
      {recentColors.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <div style={{ color: '#666', fontSize: '0.625rem', marginBottom: '0.25rem' }}>Recent</div>
          <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap' }}>
            {recentColors.slice(0, 16).map((c, i) => (
              <div
                key={i}
                onClick={() => onChange(c)}
                style={{
                  width: 16,
                  height: 16,
                  background: `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`,
                  border: '1px solid #333',
                  borderRadius: '2px',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Preset palette */}
      <div style={{ marginTop: '0.5rem' }}>
        <div style={{ color: '#666', fontSize: '0.625rem', marginBottom: '0.25rem' }}>Palette</div>
        <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap' }}>
          {PRESET_PALETTE.map((c, i) => (
            <div
              key={i}
              onClick={() => onChange(c)}
              style={{
                width: 16,
                height: 16,
                background: `rgb(${c.r}, ${c.g}, ${c.b})`,
                border: '1px solid #333',
                borderRadius: '2px',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Default palette - 16 color NES-style palette */
const PRESET_PALETTE: Color[] = [
  { r: 0, g: 0, b: 0, a: 255 },       // Black
  { r: 255, g: 255, b: 255, a: 255 }, // White
  { r: 128, g: 128, b: 128, a: 255 }, // Gray
  { r: 192, g: 192, b: 192, a: 255 }, // Light Gray
  { r: 255, g: 0, b: 0, a: 255 },     // Red
  { r: 0, g: 255, b: 0, a: 255 },     // Green
  { r: 0, g: 0, b: 255, a: 255 },     // Blue
  { r: 255, g: 255, b: 0, a: 255 },   // Yellow
  { r: 255, g: 0, b: 255, a: 255 },   // Magenta
  { r: 0, g: 255, b: 255, a: 255 },   // Cyan
  { r: 255, g: 128, b: 0, a: 255 },   // Orange
  { r: 128, g: 0, b: 255, a: 255 },   // Purple
  { r: 255, g: 128, b: 128, a: 255 }, // Pink
  { r: 128, g: 64, b: 0, a: 255 },    // Brown
  { r: 0, g: 128, b: 0, a: 255 },     // Dark Green
  { r: 0, g: 0, b: 128, a: 255 },     // Navy
];

export default ColorPicker;
