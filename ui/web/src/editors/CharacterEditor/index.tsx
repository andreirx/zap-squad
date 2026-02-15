import { useState, useRef, useCallback, useEffect } from 'react';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import type {
  Color,
  Tool,
  AnimationState,
  VisualState,
  Direction,
  CharacterDefinition,
} from '../types';
import {
  ANIMATION_STATES,
  VISUAL_STATES,
  DIRECTIONS,
  DEFAULT_FRAMES,
  DEFAULT_FRAME_DURATION,
  buildSpriteName,
} from '../types';

/** Canvas size for character sprites */
const SPRITE_WIDTH = 32;
const SPRITE_HEIGHT = 32;

/** State tab labels */
const VISUAL_STATE_LABELS: Record<VisualState, string> = {
  full: 'Full Health',
  hurt_1: 'Hurt 1 (75%)',
  hurt_2: 'Hurt 2 (50%)',
  critical: 'Critical (25%)',
};

const ANIMATION_STATE_LABELS: Record<AnimationState, string> = {
  idle: 'Idle',
  walk: 'Walk',
  melee_attack: 'Melee Attack',
  throw_attack: 'Throw Attack',
};

const DIRECTION_LABELS: Record<Direction, string> = {
  north: 'N',
  east: 'E',
  south: 'S',
  west: 'W',
};

/** Character sprite editor with visual states, animations, and directions */
export function CharacterEditor() {
  // Character metadata
  const [characterId, setCharacterId] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [frameCount, setFrameCount] = useState(DEFAULT_FRAMES);
  const [frameDuration, setFrameDuration] = useState(DEFAULT_FRAME_DURATION);

  // Current editing state
  const [visualState, setVisualState] = useState<VisualState>('full');
  const [animationState, setAnimationState] = useState<AnimationState>('idle');
  const [direction, setDirection] = useState<Direction>('south');
  const [frame, setFrame] = useState(0);

  // Drawing state
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 });
  const [zoom, setZoom] = useState(16);
  const [showGrid, setShowGrid] = useState(true);
  const [recentColors, setRecentColors] = useState<Color[]>([]);

  // All sprite data: [visualState][animationState][direction][frame] -> ImageData
  const spritesRef = useRef<Map<string, ImageData>>(new Map());

  // Canvas ref
  const canvasRef = useRef<PixelCanvasRef>(null);

  // Clipboard
  const clipboardRef = useRef<ImageData | null>(null);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [existingCharacters, setExistingCharacters] = useState<string[]>([]);

  // Animation preview
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(0);

  // Build sprite key
  const getSpriteKey = useCallback(
    (vs: VisualState, as: AnimationState, dir: Direction, f: number) =>
      `${vs}_${as}_${dir}_${f}`,
    []
  );

  // Get current sprite key
  const currentKey = getSpriteKey(visualState, animationState, direction, frame);

  // Save current canvas to sprites map
  const saveCurrentSprite = useCallback(() => {
    if (!canvasRef.current) return;
    const data = canvasRef.current.getImageData();
    spritesRef.current.set(currentKey, data);
  }, [currentKey]);

  // Load sprite from map to canvas
  const loadSprite = useCallback(
    (vs: VisualState, as: AnimationState, dir: Direction, f: number) => {
      const key = getSpriteKey(vs, as, dir, f);
      const data = spritesRef.current.get(key);
      if (data && canvasRef.current) {
        canvasRef.current.setImageData(data);
      } else if (canvasRef.current) {
        canvasRef.current.clear();
      }
    },
    [getSpriteKey]
  );

  // Change state handlers - save current before changing
  const changeVisualState = useCallback(
    (vs: VisualState) => {
      saveCurrentSprite();
      setVisualState(vs);
    },
    [saveCurrentSprite]
  );

  const changeAnimationState = useCallback(
    (as: AnimationState) => {
      saveCurrentSprite();
      setAnimationState(as);
    },
    [saveCurrentSprite]
  );

  const changeDirection = useCallback(
    (dir: Direction) => {
      saveCurrentSprite();
      setDirection(dir);
    },
    [saveCurrentSprite]
  );

  const changeFrame = useCallback(
    (f: number) => {
      saveCurrentSprite();
      setFrame(f);
    },
    [saveCurrentSprite]
  );

  // Load sprite when state changes
  useEffect(() => {
    loadSprite(visualState, animationState, direction, frame);
  }, [visualState, animationState, direction, frame, loadSprite]);

  // Animation preview effect
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setPreviewFrame((f) => (f + 1) % frameCount);
    }, frameDuration * 1000);
    return () => clearInterval(interval);
  }, [isPlaying, frameCount, frameDuration]);

  // Load existing characters on mount
  useEffect(() => {
    async function loadCharacters() {
      try {
        const storage = createStorage();
        const files = await storage.list('characters');
        const ids = [
          ...new Set(
            files
              .filter((f) => f.includes('/') && f.endsWith('definition.json'))
              .map((f) => f.split('/')[1])
          ),
        ];
        setExistingCharacters(ids);
      } catch (e) {
        console.error('Failed to load characters:', e);
      }
    }
    loadCharacters();
  }, []);

  // Load character from storage
  const loadCharacter = useCallback(async (id: string) => {
    setIsLoading(true);
    setSaveError(null);
    try {
      const storage = createStorage();

      // Load definition
      const defJson = await storage.readText(`characters/${id}/definition.json`);
      const def: CharacterDefinition = JSON.parse(defJson);
      setCharacterId(def.id);
      setCharacterName(def.name);
      setFrameCount(def.frames);
      setFrameDuration(def.frameDuration);

      // Clear existing sprites
      spritesRef.current.clear();

      // Load all sprite images
      for (const vs of VISUAL_STATES) {
        for (const as of ANIMATION_STATES) {
          for (const dir of DIRECTIONS) {
            for (let f = 0; f < def.frames; f++) {
              const filename = buildSpriteName({
                bodyId: id,
                visualState: vs,
                animationState: as,
                direction: dir,
                frame: f,
              });
              try {
                const url = storage.getReadUrl(`characters/${id}/${filename}`);
                const img = await loadImage(url);
                const data = imageToImageData(img, SPRITE_WIDTH, SPRITE_HEIGHT);
                spritesRef.current.set(getSpriteKey(vs, as, dir, f), data);
              } catch {
                // Sprite doesn't exist yet
              }
            }
          }
        }
      }

      // Reset to initial state and load sprite
      setVisualState('full');
      setAnimationState('idle');
      setDirection('south');
      setFrame(0);
      loadSprite('full', 'idle', 'south', 0);
    } catch (e) {
      setSaveError(`Failed to load character: ${e}`);
    } finally {
      setIsLoading(false);
    }
  }, [getSpriteKey, loadSprite]);

  // Save character to storage
  const saveCharacter = useCallback(async () => {
    if (!characterId.trim()) {
      setSaveError('Character ID is required');
      return;
    }

    // Save current canvas first
    saveCurrentSprite();

    setIsSaving(true);
    setSaveError(null);
    try {
      const storage = createStorage();
      const now = new Date().toISOString();

      // Save definition
      const def: CharacterDefinition = {
        id: characterId,
        name: characterName || characterId,
        frames: frameCount,
        frameDuration,
        createdAt: now,
        updatedAt: now,
      };
      await storage.writeText(
        `characters/${characterId}/definition.json`,
        JSON.stringify(def, null, 2)
      );

      // Save all sprites
      for (const [key, data] of spritesRef.current.entries()) {
        const [vs, as, dir, f] = key.split('_');
        const filename = buildSpriteName({
          bodyId: characterId,
          visualState: vs as VisualState,
          animationState: as as AnimationState,
          direction: dir as Direction,
          frame: parseInt(f, 10),
        });
        const blob = await imageDataToPng(data);
        await storage.writeBytes(
          `characters/${characterId}/${filename}`,
          await blob.arrayBuffer(),
          'image/png'
        );
      }

      // Update existing characters list
      if (!existingCharacters.includes(characterId)) {
        setExistingCharacters([...existingCharacters, characterId]);
      }

      console.log(`Saved character ${characterId} with ${spritesRef.current.size} sprites`);
    } catch (e) {
      setSaveError(`Failed to save: ${e}`);
    } finally {
      setIsSaving(false);
    }
  }, [characterId, characterName, frameCount, frameDuration, saveCurrentSprite, existingCharacters]);

  // Copy current frame to all directions
  const copyToAllDirections = useCallback(() => {
    saveCurrentSprite();
    const sourceData = spritesRef.current.get(currentKey);
    if (!sourceData) return;

    for (const dir of DIRECTIONS) {
      if (dir !== direction) {
        const key = getSpriteKey(visualState, animationState, dir, frame);
        // Clone the image data
        const copy = new ImageData(
          new Uint8ClampedArray(sourceData.data),
          sourceData.width,
          sourceData.height
        );
        spritesRef.current.set(key, copy);
      }
    }
  }, [currentKey, direction, visualState, animationState, frame, getSpriteKey, saveCurrentSprite]);

  // Copy current frame to all frames in animation
  const copyToAllFrames = useCallback(() => {
    saveCurrentSprite();
    const sourceData = spritesRef.current.get(currentKey);
    if (!sourceData) return;

    for (let f = 0; f < frameCount; f++) {
      if (f !== frame) {
        const key = getSpriteKey(visualState, animationState, direction, f);
        const copy = new ImageData(
          new Uint8ClampedArray(sourceData.data),
          sourceData.width,
          sourceData.height
        );
        spritesRef.current.set(key, copy);
      }
    }
  }, [currentKey, frame, frameCount, visualState, animationState, direction, getSpriteKey, saveCurrentSprite]);

  // Copy visual state to other visual states
  const copyToAllVisualStates = useCallback(() => {
    saveCurrentSprite();

    for (const vs of VISUAL_STATES) {
      if (vs === visualState) continue;
      for (const as of ANIMATION_STATES) {
        for (const dir of DIRECTIONS) {
          for (let f = 0; f < frameCount; f++) {
            const sourceKey = getSpriteKey(visualState, as, dir, f);
            const sourceData = spritesRef.current.get(sourceKey);
            if (sourceData) {
              const destKey = getSpriteKey(vs, as, dir, f);
              const copy = new ImageData(
                new Uint8ClampedArray(sourceData.data),
                sourceData.width,
                sourceData.height
              );
              spritesRef.current.set(destKey, copy);
            }
          }
        }
      }
    }
  }, [visualState, frameCount, getSpriteKey, saveCurrentSprite]);

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
            saveCharacter();
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
        case '[':
          setFrame((f) => Math.max(0, f - 1));
          break;
        case ']':
          setFrame((f) => Math.min(frameCount - 1, f + 1));
          break;
        case ' ':
          e.preventDefault();
          setIsPlaying((p) => !p);
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [frameCount, saveCharacter]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 60px)' }}>
      {/* Left sidebar - Character list */}
      <div
        style={{
          width: 200,
          background: '#16213e',
          padding: '1rem',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ color: '#4ecca3', margin: '0 0 1rem 0', fontSize: '1rem' }}>
          Characters
        </h3>

        <button
          onClick={() => {
            setCharacterId('');
            setCharacterName('');
            setFrameCount(DEFAULT_FRAMES);
            setFrameDuration(DEFAULT_FRAME_DURATION);
            spritesRef.current.clear();
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
          + New Character
        </button>

        {existingCharacters.map((id) => (
          <div
            key={id}
            onClick={() => loadCharacter(id)}
            style={{
              padding: '0.5rem',
              background: id === characterId ? '#4ecca3' : '#0f0f23',
              color: id === characterId ? '#1a1a2e' : '#ccc',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '0.25rem',
            }}
          >
            {id}
          </div>
        ))}
      </div>

      {/* Main editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar - Character info */}
        <div
          style={{
            padding: '0.5rem 1rem',
            background: '#16213e',
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>ID:</span>
            <input
              type="text"
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="character_id"
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

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Name:</span>
            <input
              type="text"
              value={characterName}
              onChange={(e) => setCharacterName(e.target.value)}
              placeholder="Display Name"
              style={{
                background: '#0f0f23',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '0.25rem 0.5rem',
                color: '#ccc',
                width: 150,
              }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Frames:</span>
            <input
              type="number"
              value={frameCount}
              onChange={(e) => setFrameCount(Math.max(1, Math.min(16, parseInt(e.target.value, 10) || 1)))}
              min={1}
              max={16}
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

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Duration:</span>
            <input
              type="number"
              value={frameDuration}
              onChange={(e) => setFrameDuration(Math.max(0.01, parseFloat(e.target.value) || 0.1))}
              step={0.01}
              min={0.01}
              style={{
                background: '#0f0f23',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '0.25rem 0.5rem',
                color: '#ccc',
                width: 70,
              }}
            />
            <span style={{ color: '#666', fontSize: '0.75rem' }}>sec</span>
          </label>

          <div style={{ flex: 1 }} />

          <button
            onClick={saveCharacter}
            disabled={isSaving || !characterId}
            style={{
              padding: '0.5rem 1rem',
              background: isSaving ? '#555' : '#4ecca3',
              color: isSaving ? '#999' : '#1a1a2e',
              border: 'none',
              borderRadius: '4px',
              cursor: isSaving || !characterId ? 'not-allowed' : 'pointer',
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
              overflow: 'auto',
              padding: '1rem',
              background: '#0f0f23',
            }}
          >
            {/* State tabs */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
              {/* Visual state tabs */}
              <div>
                <div style={{ color: '#666', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                  Visual State
                </div>
                <div style={{ display: 'flex', gap: '2px' }}>
                  {VISUAL_STATES.map((vs) => (
                    <button
                      key={vs}
                      onClick={() => changeVisualState(vs)}
                      style={{
                        padding: '0.25rem 0.5rem',
                        border: 'none',
                        borderRadius: '4px',
                        background: vs === visualState ? '#4ecca3' : '#16213e',
                        color: vs === visualState ? '#1a1a2e' : '#ccc',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      {VISUAL_STATE_LABELS[vs]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Animation state tabs */}
              <div>
                <div style={{ color: '#666', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                  Animation
                </div>
                <div style={{ display: 'flex', gap: '2px' }}>
                  {ANIMATION_STATES.map((as) => (
                    <button
                      key={as}
                      onClick={() => changeAnimationState(as)}
                      style={{
                        padding: '0.25rem 0.5rem',
                        border: 'none',
                        borderRadius: '4px',
                        background: as === animationState ? '#4ecca3' : '#16213e',
                        color: as === animationState ? '#1a1a2e' : '#ccc',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      {ANIMATION_STATE_LABELS[as]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Direction tabs */}
              <div>
                <div style={{ color: '#666', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                  Direction
                </div>
                <div style={{ display: 'flex', gap: '2px' }}>
                  {DIRECTIONS.map((dir) => (
                    <button
                      key={dir}
                      onClick={() => changeDirection(dir)}
                      style={{
                        width: 32,
                        height: 32,
                        border: 'none',
                        borderRadius: '4px',
                        background: dir === direction ? '#4ecca3' : '#16213e',
                        color: dir === direction ? '#1a1a2e' : '#ccc',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                      }}
                    >
                      {DIRECTION_LABELS[dir]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Frame selector */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ color: '#666', fontSize: '0.75rem' }}>Frame:</span>
              {Array.from({ length: frameCount }, (_, i) => (
                <button
                  key={i}
                  onClick={() => changeFrame(i)}
                  style={{
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: '4px',
                    background: i === frame ? '#4ecca3' : '#16213e',
                    color: i === frame ? '#1a1a2e' : '#ccc',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                  }}
                >
                  {i + 1}
                </button>
              ))}

              <div style={{ width: 1, height: 24, background: '#333', margin: '0 0.5rem' }} />

              <button
                onClick={() => setIsPlaying(!isPlaying)}
                style={{
                  padding: '0.25rem 0.5rem',
                  border: 'none',
                  borderRadius: '4px',
                  background: isPlaying ? '#ff6b6b' : '#16213e',
                  color: '#ccc',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}
              >
                {isPlaying ? 'Stop' : 'Play'}
              </button>
            </div>

            {/* Canvas */}
            <div style={{ display: 'flex', gap: '2rem' }}>
              <div>
                <PixelCanvas
                  ref={canvasRef}
                  width={SPRITE_WIDTH}
                  height={SPRITE_HEIGHT}
                  zoom={zoom}
                  tool={tool}
                  color={color}
                  showGrid={showGrid}
                  onColorPick={(c) => setColor(c)}
                  onChange={() => saveCurrentSprite()}
                />
              </div>

              {/* Animation preview */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={{ color: '#666', fontSize: '0.75rem' }}>Preview</div>
                <div
                  style={{
                    width: SPRITE_WIDTH * 4,
                    height: SPRITE_HEIGHT * 4,
                    background: '#111',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    imageRendering: 'pixelated',
                  }}
                >
                  <PreviewSprite
                    sprites={spritesRef.current}
                    spriteKey={getSpriteKey(
                      visualState,
                      animationState,
                      direction,
                      isPlaying ? previewFrame : frame
                    )}
                    width={SPRITE_WIDTH}
                    height={SPRITE_HEIGHT}
                    scale={4}
                  />
                </div>
              </div>
            </div>

            {/* Bulk copy actions */}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                onClick={copyToAllDirections}
                style={{
                  padding: '0.25rem 0.5rem',
                  border: '1px solid #333',
                  borderRadius: '4px',
                  background: '#16213e',
                  color: '#ccc',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}
              >
                Copy to all directions
              </button>
              <button
                onClick={copyToAllFrames}
                style={{
                  padding: '0.25rem 0.5rem',
                  border: '1px solid #333',
                  borderRadius: '4px',
                  background: '#16213e',
                  color: '#ccc',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}
              >
                Copy to all frames
              </button>
              <button
                onClick={copyToAllVisualStates}
                style={{
                  padding: '0.25rem 0.5rem',
                  border: '1px solid #333',
                  borderRadius: '4px',
                  background: '#16213e',
                  color: '#ccc',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}
              >
                Copy to all visual states
              </button>
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

/** Preview sprite component */
function PreviewSprite({
  sprites,
  spriteKey,
  width,
  height,
  scale,
}: {
  sprites: Map<string, ImageData>;
  spriteKey: string;
  width: number;
  height: number;
  scale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const data = sprites.get(spriteKey);
    if (data) {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) {
        tempCtx.putImageData(data, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, width * scale, height * scale);
      }
    }
  }, [sprites, spriteKey, width, height, scale]);

  return (
    <canvas
      ref={canvasRef}
      width={width * scale}
      height={height * scale}
      style={{ imageRendering: 'pixelated' }}
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

export default CharacterEditor;
