import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, Copy, ChevronLeft, ChevronRight, Trash2, Play, Pause, ArrowLeft, ArrowRight } from 'lucide-react';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import type { Color, Tool } from '../types';

/** Canvas size for object sprites - EVERYTHING IS 128x128 */
const SPRITE_SIZE = 128;
const MAX_FRAMES = 8;
const DEFAULT_FRAME_DURATION = 0.1;

/** Object animation states - only idle and landed */
type ObjectAnimation = 'idle' | 'landed';
const OBJECT_ANIMATIONS: ObjectAnimation[] = ['idle', 'landed'];

interface ObjectDefinition {
  id: string;
  name: string;
  frameDuration: number;
  createdAt: string;
  updatedAt: string;
}

interface ObjectAnimationConfig {
  frames: number;
  loop: boolean;
}

/** Object editor - simplified character editor for projectiles, items, decorations */
export function ObjectEditor() {
  // Object metadata
  const [objectId, setObjectId] = useState('');
  const [objectName, setObjectName] = useState('');
  const [frameDuration, setFrameDuration] = useState(DEFAULT_FRAME_DURATION);

  // Current editing state - animation and frame
  const [animation, setAnimation] = useState<ObjectAnimation>('idle');
  const [currentFrame, setCurrentFrame] = useState(0);

  // Animation configs - discovered from loaded files
  const [animationConfigs, setAnimationConfigs] = useState<Record<ObjectAnimation, ObjectAnimationConfig>>({
    idle: { frames: 1, loop: true },
    landed: { frames: 0, loop: false },
  });

  // Sprite data - Map<animation_frame, ImageData>
  const [sprites, setSprites] = useState<Map<string, ImageData>>(new Map());

  // Drawing state
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<Color>({ r: 76, g: 175, b: 80, a: 255 });
  const [zoom, setZoom] = useState(4);
  const [brushSize, setBrushSize] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [recentColors, setRecentColors] = useState<Color[]>([]);

  // Canvas and clipboard refs
  const canvasRef = useRef<PixelCanvasRef>(null);
  const clipboardRef = useRef<ImageData | null>(null);

  // Animation preview state
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(0);
  const previewIntervalRef = useRef<number | null>(null);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [existingObjects, setExistingObjects] = useState<string[]>([]);

  // Current frame count for selected animation
  const currentFrameCount = animationConfigs[animation].frames;

  // Build sprite key
  const buildSpriteKey = (anim: ObjectAnimation, frame: number) => `${anim}_${frame}`;

  // Save current canvas to sprites
  const saveCurrentSprite = useCallback(() => {
    if (!canvasRef.current) return;
    const data = canvasRef.current.getImageData();
    const key = buildSpriteKey(animation, currentFrame);
    setSprites(prev => {
      const next = new Map(prev);
      next.set(key, new ImageData(
        new Uint8ClampedArray(data.data),
        data.width,
        data.height
      ));
      return next;
    });
  }, [animation, currentFrame]);

  // Load sprite to canvas
  const loadSprite = useCallback((anim: ObjectAnimation, frame: number) => {
    const key = buildSpriteKey(anim, frame);
    const data = sprites.get(key);
    if (data && canvasRef.current) {
      canvasRef.current.setImageData(data);
    } else if (canvasRef.current) {
      canvasRef.current.clear();
    }
  }, [sprites]);

  // Change frame
  const changeFrame = useCallback((frame: number) => {
    saveCurrentSprite();
    setCurrentFrame(frame);
  }, [saveCurrentSprite]);

  // Change animation
  const changeAnimation = useCallback((anim: ObjectAnimation) => {
    saveCurrentSprite();
    setAnimation(anim);
    setCurrentFrame(0);
  }, [saveCurrentSprite]);

  // Load sprite when selection changes
  useEffect(() => {
    loadSprite(animation, currentFrame);
  }, [animation, currentFrame, loadSprite]);

  // Load existing objects on mount
  useEffect(() => {
    async function loadObjects() {
      try {
        const storage = createStorage();
        const files = await storage.list('objects');
        const ids = [
          ...new Set(
            files
              .filter((f) => f.includes('/') && (f.endsWith('definition.json') || f.endsWith('properties.json')))
              .map((f) => f.split('/')[1])
          ),
        ];
        setExistingObjects(ids);
      } catch (e) {
        console.error('Failed to load objects:', e);
      }
    }
    loadObjects();
  }, []);

  // Load object from storage
  const loadObject = useCallback(async (id: string) => {
    setIsLoading(true);
    setSaveError(null);
    try {
      const storage = createStorage();

      // Load definition (try both formats)
      let def: ObjectDefinition;
      try {
        const json = await storage.readText(`objects/${id}/definition.json`);
        def = JSON.parse(json);
      } catch {
        const json = await storage.readText(`objects/${id}/properties.json`);
        def = JSON.parse(json);
      }

      setObjectId(def.id || id);
      setObjectName(def.name || id);
      setFrameDuration(def.frameDuration ?? DEFAULT_FRAME_DURATION);

      // Discover frames by trying to load each animation's frames
      const newSprites = new Map<string, ImageData>();
      const newConfigs: Record<ObjectAnimation, ObjectAnimationConfig> = {
        idle: { frames: 0, loop: true },
        landed: { frames: 0, loop: false },
      };

      for (const anim of OBJECT_ANIMATIONS) {
        for (let f = 0; f < MAX_FRAMES; f++) {
          // Try new format first: {id}_{animation}_{frame}.png
          const newFilename = `${id}_${anim}_${f}.png`;
          try {
            const url = storage.getReadUrl(`objects/${id}/${newFilename}`);
            const img = await loadImage(url);
            const data = imageToImageData(img, SPRITE_SIZE, SPRITE_SIZE);
            newSprites.set(buildSpriteKey(anim, f), data);
            newConfigs[anim].frames = f + 1;
          } catch {
            // Frame doesn't exist, stop trying more frames for this animation
            break;
          }
        }
      }

      // Ensure at least 1 frame for idle
      if (newConfigs.idle.frames === 0) {
        newConfigs.idle.frames = 1;
      }

      setSprites(newSprites);
      setAnimationConfigs(newConfigs);
      setAnimation('idle');
      setCurrentFrame(0);

      // Load first frame to canvas
      const firstKey = buildSpriteKey('idle', 0);
      const firstSprite = newSprites.get(firstKey);
      if (firstSprite && canvasRef.current) {
        canvasRef.current.setImageData(firstSprite);
      } else if (canvasRef.current) {
        canvasRef.current.clear();
      }
    } catch (e) {
      setSaveError(`Failed to load object: ${e}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save object to storage
  const saveObject = useCallback(async () => {
    if (!objectId.trim()) {
      setSaveError('Object ID is required');
      return;
    }

    saveCurrentSprite();

    setIsSaving(true);
    setSaveError(null);
    try {
      const storage = createStorage();
      const now = new Date().toISOString();

      // Save definition
      const def: ObjectDefinition = {
        id: objectId,
        name: objectName || objectId,
        frameDuration,
        createdAt: now,
        updatedAt: now,
      };
      await storage.writeText(
        `objects/${objectId}/definition.json`,
        JSON.stringify(def, null, 2)
      );

      // Save all sprites
      for (const [key, data] of sprites.entries()) {
        const [anim, frame] = key.split('_');
        const filename = `${objectId}_${anim}_${frame}.png`;
        const blob = await imageDataToPng(data);
        await storage.writeBytes(
          `objects/${objectId}/${filename}`,
          await blob.arrayBuffer(),
          'image/png'
        );
      }

      if (!existingObjects.includes(objectId)) {
        setExistingObjects([...existingObjects, objectId]);
      }

      console.log(`Saved object ${objectId}`);
    } catch (e) {
      setSaveError(`Failed to save: ${e}`);
    } finally {
      setIsSaving(false);
    }
  }, [objectId, objectName, frameDuration, sprites, existingObjects, saveCurrentSprite]);

  // Add frame to current animation
  const addFrame = useCallback(() => {
    if (currentFrameCount >= MAX_FRAMES) return;
    saveCurrentSprite();
    setAnimationConfigs(prev => ({
      ...prev,
      [animation]: { ...prev[animation], frames: prev[animation].frames + 1 },
    }));
    setCurrentFrame(currentFrameCount);
  }, [animation, currentFrameCount, saveCurrentSprite]);

  // Duplicate current frame
  const duplicateFrame = useCallback(() => {
    if (currentFrameCount >= MAX_FRAMES) return;
    saveCurrentSprite();

    const currentKey = buildSpriteKey(animation, currentFrame);
    const currentData = sprites.get(currentKey);

    if (currentData) {
      const newFrameIndex = currentFrameCount;
      const newKey = buildSpriteKey(animation, newFrameIndex);
      setSprites(prev => {
        const next = new Map(prev);
        next.set(newKey, new ImageData(
          new Uint8ClampedArray(currentData.data),
          currentData.width,
          currentData.height
        ));
        return next;
      });
    }

    setAnimationConfigs(prev => ({
      ...prev,
      [animation]: { ...prev[animation], frames: prev[animation].frames + 1 },
    }));
    setCurrentFrame(currentFrameCount);
  }, [animation, currentFrame, currentFrameCount, sprites, saveCurrentSprite]);

  // Delete current frame
  const deleteFrame = useCallback(() => {
    if (currentFrameCount <= 1) return;
    saveCurrentSprite();

    // Rebuild sprites without this frame and shift subsequent frames
    setSprites(prev => {
      const next = new Map<string, ImageData>();
      for (const [key, data] of prev.entries()) {
        const [anim, frameStr] = key.split('_');
        const frame = parseInt(frameStr, 10);

        if (anim === animation) {
          if (frame < currentFrame) {
            next.set(key, data);
          } else if (frame > currentFrame) {
            next.set(buildSpriteKey(animation, frame - 1), data);
          }
          // Skip current frame
        } else {
          next.set(key, data);
        }
      }
      return next;
    });

    setAnimationConfigs(prev => ({
      ...prev,
      [animation]: { ...prev[animation], frames: prev[animation].frames - 1 },
    }));
    setCurrentFrame(prev => Math.max(0, prev - 1));
  }, [animation, currentFrame, currentFrameCount, saveCurrentSprite]);

  // Move current frame left
  const moveFrameLeft = useCallback(() => {
    if (currentFrame <= 0) return;
    saveCurrentSprite();

    const currentKey = buildSpriteKey(animation, currentFrame);
    const prevKey = buildSpriteKey(animation, currentFrame - 1);
    const currentData = sprites.get(currentKey);
    const prevData = sprites.get(prevKey);

    setSprites(prev => {
      const next = new Map(prev);
      if (currentData) next.set(prevKey, currentData);
      else next.delete(prevKey);
      if (prevData) next.set(currentKey, prevData);
      else next.delete(currentKey);
      return next;
    });

    setCurrentFrame(currentFrame - 1);
  }, [animation, currentFrame, sprites, saveCurrentSprite]);

  // Move current frame right
  const moveFrameRight = useCallback(() => {
    if (currentFrame >= currentFrameCount - 1) return;
    saveCurrentSprite();

    const currentKey = buildSpriteKey(animation, currentFrame);
    const nextKey = buildSpriteKey(animation, currentFrame + 1);
    const currentData = sprites.get(currentKey);
    const nextData = sprites.get(nextKey);

    setSprites(prev => {
      const next = new Map(prev);
      if (currentData) next.set(nextKey, currentData);
      else next.delete(nextKey);
      if (nextData) next.set(currentKey, nextData);
      else next.delete(currentKey);
      return next;
    });

    setCurrentFrame(currentFrame + 1);
  }, [animation, currentFrame, currentFrameCount, sprites, saveCurrentSprite]);

  // Animation preview
  useEffect(() => {
    if (isPlaying) {
      previewIntervalRef.current = window.setInterval(() => {
        setPreviewFrame(prev => (prev + 1) % currentFrameCount);
      }, frameDuration * 1000);
    } else {
      if (previewIntervalRef.current) {
        clearInterval(previewIntervalRef.current);
        previewIntervalRef.current = null;
      }
    }
    return () => {
      if (previewIntervalRef.current) {
        clearInterval(previewIntervalRef.current);
      }
    };
  }, [isPlaying, frameDuration, currentFrameCount]);

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

  // New object
  const newObject = useCallback(() => {
    setObjectId('');
    setObjectName('');
    setFrameDuration(DEFAULT_FRAME_DURATION);
    setAnimation('idle');
    setCurrentFrame(0);
    setAnimationConfigs({
      idle: { frames: 1, loop: true },
      landed: { frames: 0, loop: false },
    });
    setSprites(new Map());
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
            saveObject();
            break;
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'p': setTool('pencil'); break;
        case 'e': setTool('eraser'); break;
        case 'g': setTool('fill'); break;
        case 'l': setTool('line'); break;
        case '[': changeFrame(Math.max(0, currentFrame - 1)); break;
        case ']': changeFrame(Math.min(currentFrameCount - 1, currentFrame + 1)); break;
        case ' ': e.preventDefault(); setIsPlaying(p => !p); break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveObject, currentFrame, currentFrameCount, changeFrame]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar - Object list */}
      <div style={{ width: 200, background: '#16213e', padding: '1rem', overflowY: 'auto' }}>
        <h3 style={{ color: '#4ecca3', margin: '0 0 1rem 0', fontSize: '1rem' }}>Objects</h3>

        <button
          onClick={newObject}
          style={{
            width: '100%', padding: '0.5rem', background: '#4ecca3', color: '#1a1a2e',
            border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', marginBottom: '0.5rem',
          }}
        >
          + New Object
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {existingObjects.map((id) => (
            <div
              key={id}
              onClick={() => loadObject(id)}
              style={{
                padding: '0.5rem', background: id === objectId ? '#4ecca3' : '#0f0f23',
                color: id === objectId ? '#1a1a2e' : '#ccc', borderRadius: '4px', cursor: 'pointer',
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
              type="text" value={objectId}
              onChange={(e) => setObjectId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              style={{ background: '#0f0f23', border: '1px solid #333', borderRadius: '4px', padding: '0.25rem 0.5rem', color: '#ccc', width: 120 }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Name:</span>
            <input
              type="text" value={objectName}
              onChange={(e) => setObjectName(e.target.value)}
              style={{ background: '#0f0f23', border: '1px solid #333', borderRadius: '4px', padding: '0.25rem 0.5rem', color: '#ccc', width: 140 }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Frame Duration:</span>
            <input
              type="number" value={frameDuration} min={0.01} max={1} step={0.01}
              onChange={(e) => setFrameDuration(parseFloat(e.target.value) || 0.1)}
              style={{ background: '#0f0f23', border: '1px solid #333', borderRadius: '4px', padding: '0.25rem 0.5rem', color: '#ccc', width: 60 }}
            />
            <span style={{ color: '#666', fontSize: '0.75rem' }}>s</span>
          </label>

          <div style={{ flex: 1 }} />

          <button
            onClick={saveObject}
            disabled={isSaving || !objectId}
            style={{
              padding: '0.5rem 1rem', background: isSaving ? '#555' : '#4ecca3',
              color: isSaving ? '#999' : '#1a1a2e', border: 'none', borderRadius: '4px',
              cursor: isSaving || !objectId ? 'not-allowed' : 'pointer', fontWeight: 'bold',
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
            {/* Animation tabs */}
            <div style={{ display: 'flex', gap: '2px', marginBottom: '1rem' }}>
              {OBJECT_ANIMATIONS.map(anim => {
                const config = animationConfigs[anim];
                const hasFrames = config.frames > 0;
                return (
                  <button
                    key={anim}
                    onClick={() => changeAnimation(anim)}
                    style={{
                      padding: '0.5rem 1rem',
                      border: 'none',
                      borderRadius: '4px 4px 0 0',
                      background: animation === anim ? '#4ecca3' : (hasFrames ? '#16213e' : '#0a0a15'),
                      color: animation === anim ? '#1a1a2e' : (hasFrames ? '#ccc' : '#555'),
                      cursor: 'pointer',
                      fontWeight: animation === anim ? 'bold' : 'normal',
                    }}
                  >
                    {anim} {config.loop ? '(loop)' : '(once)'}
                    {hasFrames && <span style={{ marginLeft: '0.25rem', fontSize: '0.75rem' }}>({config.frames})</span>}
                  </button>
                );
              })}
            </div>

            {/* Frame controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ color: '#666', fontSize: '0.75rem' }}>
                Frame {currentFrame + 1} / {currentFrameCount}
              </span>

              <button onClick={() => changeFrame(Math.max(0, currentFrame - 1))}
                disabled={currentFrame === 0}
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentFrame === 0 ? '#555' : '#ccc', cursor: currentFrame === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ChevronLeft size={16} />
              </button>

              <button onClick={() => changeFrame(Math.min(currentFrameCount - 1, currentFrame + 1))}
                disabled={currentFrame >= currentFrameCount - 1}
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentFrame >= currentFrameCount - 1 ? '#555' : '#ccc', cursor: currentFrame >= currentFrameCount - 1 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ChevronRight size={16} />
              </button>

              <button onClick={addFrame} disabled={currentFrameCount >= MAX_FRAMES}
                title="Add Frame"
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentFrameCount >= MAX_FRAMES ? '#555' : '#4ecca3', cursor: currentFrameCount >= MAX_FRAMES ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Plus size={16} />
              </button>

              <button onClick={duplicateFrame} disabled={currentFrameCount >= MAX_FRAMES}
                title="Duplicate Frame"
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentFrameCount >= MAX_FRAMES ? '#555' : '#ffd93d', cursor: currentFrameCount >= MAX_FRAMES ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Copy size={16} />
              </button>

              <button onClick={deleteFrame} disabled={currentFrameCount <= 1}
                title="Delete Frame"
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentFrameCount <= 1 ? '#555' : '#ff6b6b', cursor: currentFrameCount <= 1 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Trash2 size={16} />
              </button>

              <div style={{ width: 1, height: 20, background: '#333', margin: '0 0.25rem' }} />

              <button onClick={moveFrameLeft} disabled={currentFrame <= 0}
                title="Move Frame Left"
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentFrame <= 0 ? '#555' : '#ccc', cursor: currentFrame <= 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ArrowLeft size={16} />
              </button>

              <button onClick={moveFrameRight} disabled={currentFrame >= currentFrameCount - 1}
                title="Move Frame Right"
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: currentFrame >= currentFrameCount - 1 ? '#555' : '#ccc', cursor: currentFrame >= currentFrameCount - 1 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ArrowRight size={16} />
              </button>

              <div style={{ flex: 1 }} />

              <button onClick={() => setIsPlaying(!isPlaying)}
                title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                style={{ width: 28, height: 28, border: 'none', borderRadius: '4px', background: '#16213e', color: isPlaying ? '#ff6b6b' : '#4ecca3', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
            </div>

            {/* Canvas */}
            <PixelCanvas
              ref={canvasRef}
              width={SPRITE_SIZE}
              height={SPRITE_SIZE}
              zoom={zoom}
              onZoomChange={setZoom}
              tool={tool}
              color={color}
              brushSize={brushSize}
              showGrid={showGrid}
              onColorPick={(c) => setColor(c)}
              onChange={() => saveCurrentSprite()}
            />

            {/* Frame thumbnails */}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {Array.from({ length: currentFrameCount }, (_, i) => (
                <FrameThumbnail
                  key={`${animation}_${i}`}
                  data={sprites.get(buildSpriteKey(animation, i))}
                  selected={i === currentFrame}
                  playing={isPlaying && i === previewFrame}
                  onClick={() => changeFrame(i)}
                  label={i + 1}
                />
              ))}
            </div>
          </div>

          {/* Right sidebar */}
          <div style={{ width: 250, background: '#16213e', padding: '0.5rem', overflowY: 'auto' }}>
            {/* Animation preview */}
            <div style={{ marginBottom: '1rem', padding: '0.5rem', background: '#0f0f23', borderRadius: '4px' }}>
              <div style={{ color: '#4ecca3', fontWeight: 'bold', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                Preview
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem', background: '#1a1a2e', borderRadius: '4px' }}>
                <AnimationPreview
                  sprites={sprites}
                  animation={animation}
                  isPlaying={isPlaying}
                  previewFrame={previewFrame}
                />
              </div>
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

/** Frame thumbnail */
function FrameThumbnail({ data, selected, playing, onClick, label }: {
  data?: ImageData;
  selected: boolean;
  playing: boolean;
  onClick: () => void;
  label: number;
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
      ctx.fillText(String(label), 16, 20);
    }
  }, [data, label]);

  return (
    <div onClick={onClick} title={`Frame ${label}`}
      style={{
        position: 'relative',
        border: playing ? '2px solid #ffd93d' : (selected ? '2px solid #4ecca3' : '1px solid #333'),
        borderRadius: '4px',
        cursor: 'pointer',
      }}>
      <canvas ref={canvasRef} width={32} height={32} style={{ display: 'block', imageRendering: 'pixelated' }} />
    </div>
  );
}

/** Animation preview display */
function AnimationPreview({ sprites, animation, isPlaying, previewFrame }: {
  sprites: Map<string, ImageData>;
  animation: ObjectAnimation;
  isPlaying: boolean;
  previewFrame: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const frame = isPlaying ? previewFrame : 0;
    const key = `${animation}_${frame}`;
    const data = sprites.get(key);

    ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    if (data) {
      ctx.putImageData(data, 0, 0);
    }
  }, [sprites, animation, isPlaying, previewFrame]);

  return (
    <canvas
      ref={canvasRef}
      width={SPRITE_SIZE}
      height={SPRITE_SIZE}
      style={{ imageRendering: 'pixelated', width: 64, height: 64 }}
    />
  );
}

// Helpers
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

export default ObjectEditor;
