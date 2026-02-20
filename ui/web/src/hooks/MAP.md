# Hooks (`ui/web/src/hooks/`)

## Role: Shared Logic
Custom React hooks that encapsulate reusable logic.

## Key Hooks

### useCanvasTransform
Manages canvas pan/zoom transform state with proper zoom-to-point behavior.

**Features:**
- Zoom centered on cursor position
- Pan via middle mouse, right mouse, or space+drag
- Coordinate conversion (screen <-> world)
- Fit-to-view and center-on-point utilities

**API:**
```typescript
const {
  transform,        // { scale, offsetX, offsetY }
  handlers,         // Event handlers to attach to container
  screenToWorld,    // (screenX, screenY) => { x, y }
  worldToScreen,    // (worldX, worldY) => { x, y }
  zoomToPoint,      // (screenX, screenY, newScale) => void
  zoomBy,           // (screenX, screenY, delta) => void
  panBy,            // (dx, dy) => void
  fitToView,        // (contentW, contentH, viewportW, viewportH, padding?) => void
  centerOn,         // (worldX, worldY, viewportW, viewportH) => void
  isPanning,        // boolean
} = useCanvasTransform({
  initialScale: 1,
  minScale: 0.1,
  maxScale: 10,
  zoomSpeed: 0.001,
  enablePan: true,
  enableWheelZoom: true,
});
```

**Usage:**
```tsx
<div
  {...handlers}
  style={{
    overflow: 'hidden',
    cursor: isPanning ? 'grabbing' : 'crosshair',
  }}
>
  <canvas
    style={{
      transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
      transformOrigin: '0 0',
    }}
  />
</div>
```

### useHotReload
Manages the hot-reloading of game assets (scripts, levels) from the editors into the running game engine.

## Dependencies
- Does not depend on UI components.
- May depend on `storage` or `services`.
