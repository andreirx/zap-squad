import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, Copy, Trash2, ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import type {
  Color,
  Tool,
  AnimationState,
  Direction,
} from '../types';
import {
  ANIMATION_STATES,
  DIRECTIONS,
  MAX_FRAMES,
  DEFAULT_FRAME_DURATION,
} from '../types';

/** Canvas size for character sprites */
const SPRITE_WIDTH = 128;
const SPRITE_HEIGHT = 128;

const ANIMATION_STATE_LABELS: Record<AnimationState, string> = {
  idle: 'Idle',
  walk: 'Walk',
  melee_attack: 'Melee',
  throw_attack: 'Throw',
};

const DIRECTION_LABELS: Record<Direction, string> = {
  north: 'N',
  east: 'E',
  south: 'S',
  west: 'W',
};

/** Character definition - frame count discovered from files, not stored */
interface CharacterDefinition {
  id: string;
  name: string;
  frameDuration: number;
  weaponDefId?: string;
  throwableDefId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Character sprite editor - frame count discovered, not configured */
export function CharacterEditor() {
  // Character metadata
  const [characterId, setCharacterId] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [frameDuration, setFrameDuration] = useState(DEFAULT_FRAME_DURATION);

  // Equipment
  const [weaponDefId, setWeaponDefId] = useState<string>('');
  const [throwableDefId, setThrowableDefId] = useState<string>('');
  const [availableWeapons, setAvailableWeapons] = useState<{ id: string; name: string }[]>([]);
  const [availableObjects, setAvailableObjects] = useState<{ id: string; name: string }[]>([]);

  // Discovered frame counts per animation (from existing sprites)
  const [frameCounts, setFrameCounts] = useState<Record<AnimationState, number>>({
    idle: 1,
    walk: 1,
    melee_attack: 1,
    throw_attack: 1,
  });

  // Current editing state
  const [animationState, setAnimationState] = useState<AnimationState>('idle');
  const [direction, setDirection] = useState<Direction>('south');
  const [frame, setFrame] = useState(0);

  // Drawing state
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 });
  const [zoom, setZoom] = useState(4);
  const [brushSize, setBrushSize] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [recentColors, setRecentColors] = useState<Color[]>([]);

  // All sprite data: [animationState][direction][frame] -> ImageData
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

  // Current frame count for selected animation
  const currentFrameCount = frameCounts[animationState];

  // Build sprite key
  const getSpriteKey = useCallback(
    (as: AnimationState, dir: Direction, f: number) => `${as}_${dir}_${f}`,
    []
  );

  // Get current sprite key
  const currentKey = getSpriteKey(animationState, direction, frame);

  // Save current canvas to sprites map
  const saveCurrentSprite = useCallback(() => {
    if (!canvasRef.current) return;
    const data = canvasRef.current.getImageData();
    spritesRef.current.set(currentKey, data);
  }, [currentKey]);

  // Load sprite from map to canvas
  const loadSprite = useCallback(
    (as: AnimationState, dir: Direction, f: number) => {
      const key = getSpriteKey(as, dir, f);
      const data = spritesRef.current.get(key);
      if (data && canvasRef.current) {
        canvasRef.current.setImageData(data);
      } else if (canvasRef.current) {
        canvasRef.current.clear();
      }
    },
    [getSpriteKey]
  );

  // Change animation state handler
  const changeAnimationState = useCallback(
    (as: AnimationState) => {
      saveCurrentSprite();
      setAnimationState(as);
      // Reset frame if exceeds this animation's frame count
      const newFrameCount = frameCounts[as];
      if (frame >= newFrameCount) {
        setFrame(0);
      }
    },
    [saveCurrentSprite, frame, frameCounts]
  );

  // Change direction handler
  const changeDirection = useCallback(
    (dir: Direction) => {
      saveCurrentSprite();
      setDirection(dir);
    },
    [saveCurrentSprite]
  );

  // Change frame handler
  const changeFrame = useCallback(
    (f: number) => {
      saveCurrentSprite();
      setFrame(f);
    },
    [saveCurrentSprite]
  );

  // Add a new frame to current animation (up to MAX_FRAMES)
  const addFrame = useCallback(() => {
    if (currentFrameCount >= MAX_FRAMES) return;

    saveCurrentSprite();
    setFrameCounts(prev => ({
      ...prev,
      [animationState]: prev[animationState] + 1,
    }));
    // Switch to the new frame
    setFrame(currentFrameCount);
  }, [currentFrameCount, animationState, saveCurrentSprite]);

  // Duplicate current frame as a new frame
  const duplicateFrame = useCallback(() => {
    if (currentFrameCount >= MAX_FRAMES) return;

    saveCurrentSprite();
    const sourceData = spritesRef.current.get(currentKey);

    // Add new frame
    const newFrameIndex = currentFrameCount;
    setFrameCounts(prev => ({
      ...prev,
      [animationState]: prev[animationState] + 1,
    }));

    // Copy current frame to new frame for all directions
    if (sourceData) {
      for (const dir of DIRECTIONS) {
        const sourceKey = getSpriteKey(animationState, dir, frame);
        const destKey = getSpriteKey(animationState, dir, newFrameIndex);
        const srcData = spritesRef.current.get(sourceKey);
        if (srcData) {
          const copy = new ImageData(
            new Uint8ClampedArray(srcData.data),
            srcData.width,
            srcData.height
          );
          spritesRef.current.set(destKey, copy);
        }
      }
    }

    // Switch to the new frame
    setFrame(newFrameIndex);
  }, [currentFrameCount, animationState, currentKey, frame, getSpriteKey, saveCurrentSprite]);

  // Delete current frame
  const deleteFrame = useCallback(() => {
    if (currentFrameCount <= 1) return;
    saveCurrentSprite();

    // Shift all frames after current one down
    for (const dir of DIRECTIONS) {
      for (let f = frame; f < currentFrameCount - 1; f++) {
        const srcKey = getSpriteKey(animationState, dir, f + 1);
        const destKey = getSpriteKey(animationState, dir, f);
        const srcData = spritesRef.current.get(srcKey);
        if (srcData) {
          spritesRef.current.set(destKey, srcData);
        } else {
          spritesRef.current.delete(destKey);
        }
      }
      // Delete the last frame slot
      spritesRef.current.delete(getSpriteKey(animationState, dir, currentFrameCount - 1));
    }

    setFrameCounts(prev => ({
      ...prev,
      [animationState]: prev[animationState] - 1,
    }));
    setFrame(prev => Math.max(0, prev - 1));
  }, [currentFrameCount, animationState, frame, getSpriteKey, saveCurrentSprite]);

  // Move current frame left
  const moveFrameLeft = useCallback(() => {
    if (frame <= 0) return;
    saveCurrentSprite();

    // Swap frame and frame-1 for all directions
    for (const dir of DIRECTIONS) {
      const currentKey = getSpriteKey(animationState, dir, frame);
      const prevKey = getSpriteKey(animationState, dir, frame - 1);
      const currentData = spritesRef.current.get(currentKey);
      const prevData = spritesRef.current.get(prevKey);

      if (currentData) spritesRef.current.set(prevKey, currentData);
      else spritesRef.current.delete(prevKey);

      if (prevData) spritesRef.current.set(currentKey, prevData);
      else spritesRef.current.delete(currentKey);
    }

    setFrame(frame - 1);
  }, [frame, animationState, getSpriteKey, saveCurrentSprite]);

  // Move current frame right
  const moveFrameRight = useCallback(() => {
    if (frame >= currentFrameCount - 1) return;
    saveCurrentSprite();

    // Swap frame and frame+1 for all directions
    for (const dir of DIRECTIONS) {
      const currentKey = getSpriteKey(animationState, dir, frame);
      const nextKey = getSpriteKey(animationState, dir, frame + 1);
      const currentData = spritesRef.current.get(currentKey);
      const nextData = spritesRef.current.get(nextKey);

      if (currentData) spritesRef.current.set(nextKey, currentData);
      else spritesRef.current.delete(nextKey);

      if (nextData) spritesRef.current.set(currentKey, nextData);
      else spritesRef.current.delete(currentKey);
    }

    setFrame(frame + 1);
  }, [frame, currentFrameCount, animationState, getSpriteKey, saveCurrentSprite]);

  // Load sprite when state changes
  useEffect(() => {
    loadSprite(animationState, direction, frame);
  }, [animationState, direction, frame, loadSprite]);

  // Animation preview effect
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setPreviewFrame((f) => (f + 1) % currentFrameCount);
    }, frameDuration * 1000);
    return () => clearInterval(interval);
  }, [isPlaying, currentFrameCount, frameDuration]);

  // Load existing characters, weapons, and objects on mount
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
    async function loadEquipment() {
      try {
        const storage = createStorage();
        // Load available objects (used for both weapon and throwable dropdowns)
        const objFiles = await storage.list('objects');
        const objIds = [...new Set(
          objFiles
            .filter((f) => f.includes('/') && f.endsWith('definition.json'))
            .map((f) => f.split('/')[1])
        )];
        const objects: { id: string; name: string }[] = [];
        for (const id of objIds) {
          try {
            const json = await storage.readText(`objects/${id}/definition.json`);
            const def = JSON.parse(json);
            objects.push({ id, name: def.name || id });
          } catch { objects.push({ id, name: id }); }
        }
        // Both dropdowns draw from the same object pool
        setAvailableWeapons(objects);
        setAvailableObjects(objects);
      } catch (e) {
        console.error('Failed to load equipment:', e);
      }
    }
    loadCharacters();
    loadEquipment();
  }, []);

  // Load character from storage - discover frame counts from files
  // Supports both old format (with visual states) and new format (without)
  const loadCharacter = useCallback(
    async (id: string) => {
      setIsLoading(true);
      setSaveError(null);
      try {
        const storage = createStorage();

        // Load definition
        const defJson = await storage.readText(`characters/${id}/definition.json`);
        const def: CharacterDefinition = JSON.parse(defJson);
        setCharacterId(def.id);
        setCharacterName(def.name);
        setFrameDuration(def.frameDuration || DEFAULT_FRAME_DURATION);
        setWeaponDefId(def.weaponDefId || '');
        setThrowableDefId(def.throwableDefId || '');

        // Clear existing sprites
        spritesRef.current.clear();

        // Discover frame counts by checking which files exist
        const discoveredFrameCounts: Record<AnimationState, number> = {
          idle: 1,
          walk: 1,
          melee_attack: 1,
          throw_attack: 1,
        };

        // Load all sprite images and discover frame counts
        // Try both new format (no visual state) and old format (with _full_)
        for (const as of ANIMATION_STATES) {
          let maxFrame = 0;
          for (const dir of DIRECTIONS) {
            for (let f = 0; f < MAX_FRAMES; f++) {
              // Try new format first: {id}_{anim}_{dir}_{frame}.png
              const newFilename = `${id}_${as}_${dir}_${f}.png`;
              // Try old format with visual state: {id}_full_{anim}_{dir}_{frame}.png
              const oldFilename = `${id}_full_${as}_${dir}_${f}.png`;

              let loaded = false;

              // Try new format
              try {
                const url = storage.getReadUrl(`characters/${id}/${newFilename}`);
                const img = await loadImage(url);
                const data = imageToImageData(img, SPRITE_WIDTH, SPRITE_HEIGHT);
                spritesRef.current.set(getSpriteKey(as, dir, f), data);
                maxFrame = Math.max(maxFrame, f + 1);
                loaded = true;
              } catch {
                // New format doesn't exist, try old format
              }

              // Try old format if new didn't work
              if (!loaded) {
                try {
                  const url = storage.getReadUrl(`characters/${id}/${oldFilename}`);
                  const img = await loadImage(url);
                  const data = imageToImageData(img, SPRITE_WIDTH, SPRITE_HEIGHT);
                  spritesRef.current.set(getSpriteKey(as, dir, f), data);
                  maxFrame = Math.max(maxFrame, f + 1);
                  loaded = true;
                } catch {
                  // Neither format exists - stop looking for more frames
                }
              }

              if (!loaded) {
                break; // No more frames in this direction
              }
            }
          }
          discoveredFrameCounts[as] = Math.max(1, maxFrame);
        }

        setFrameCounts(discoveredFrameCounts);

        // Reset to initial state and load sprite
        setAnimationState('idle');
        setDirection('south');
        setFrame(0);
        loadSprite('idle', 'south', 0);
      } catch (e) {
        setSaveError(`Failed to load character: ${e}`);
      } finally {
        setIsLoading(false);
      }
    },
    [getSpriteKey, loadSprite]
  );

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

      // Save definition (frame counts are discovered, not stored)
      const def: CharacterDefinition = {
        id: characterId,
        name: characterName || characterId,
        frameDuration,
        ...(weaponDefId ? { weaponDefId } : {}),
        ...(throwableDefId ? { throwableDefId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await storage.writeText(
        `characters/${characterId}/definition.json`,
        JSON.stringify(def, null, 2)
      );

      // Save all sprites
      for (const [key, data] of spritesRef.current.entries()) {
        const [as, dir, f] = key.split('_');
        const filename = `${characterId}_${as}_${dir}_${f}.png`;
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
  }, [characterId, characterName, frameDuration, saveCurrentSprite, existingCharacters]);

  // Copy current frame to all directions
  const copyToAllDirections = useCallback(() => {
    saveCurrentSprite();
    const sourceData = spritesRef.current.get(currentKey);
    if (!sourceData) return;

    for (const dir of DIRECTIONS) {
      if (dir !== direction) {
        const key = getSpriteKey(animationState, dir, frame);
        const copy = new ImageData(
          new Uint8ClampedArray(sourceData.data),
          sourceData.width,
          sourceData.height
        );
        spritesRef.current.set(key, copy);
      }
    }
  }, [currentKey, direction, animationState, frame, getSpriteKey, saveCurrentSprite]);

  // Copy current frame to all frames in animation
  const copyToAllFrames = useCallback(() => {
    saveCurrentSprite();
    const sourceData = spritesRef.current.get(currentKey);
    if (!sourceData) return;

    for (let f = 0; f < currentFrameCount; f++) {
      if (f !== frame) {
        const key = getSpriteKey(animationState, direction, f);
        const copy = new ImageData(
          new Uint8ClampedArray(sourceData.data),
          sourceData.width,
          sourceData.height
        );
        spritesRef.current.set(key, copy);
      }
    }
  }, [currentKey, frame, currentFrameCount, animationState, direction, getSpriteKey, saveCurrentSprite]);

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
          case 'x':
            e.preventDefault();
            clipboardRef.current = canvasRef.current?.copySelection() || null;
            canvasRef.current?.deleteSelection();
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
          setFrame((f) => Math.min(currentFrameCount - 1, f + 1));
          break;
        case ' ':
          e.preventDefault();
          setIsPlaying((p) => !p);
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentFrameCount, saveCharacter]);

  // New character - reset everything
  const newCharacter = useCallback(() => {
    setCharacterId('');
    setCharacterName('');
    setFrameCounts({
      idle: 1,
      walk: 1,
      melee_attack: 1,
      throw_attack: 1,
    });
    setFrameDuration(DEFAULT_FRAME_DURATION);
    spritesRef.current.clear();
    canvasRef.current?.clear();
    setAnimationState('idle');
    setDirection('south');
    setFrame(0);
  }, []);

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
          onClick={newCharacter}
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
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Frame Duration:</span>
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

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Weapon:</span>
            <select
              value={weaponDefId}
              onChange={(e) => setWeaponDefId(e.target.value)}
              style={{
                background: '#0f0f23',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '0.25rem 0.5rem',
                color: '#ccc',
                fontSize: '0.875rem',
              }}
            >
              <option value="">None</option>
              {availableWeapons.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#888', fontSize: '0.875rem' }}>Throwable:</span>
            <select
              value={throwableDefId}
              onChange={(e) => setThrowableDefId(e.target.value)}
              style={{
                background: '#0f0f23',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '0.25rem 0.5rem',
                color: '#ccc',
                fontSize: '0.875rem',
              }}
            >
              <option value="">None</option>
              {availableObjects.map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
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
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
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
          onCut={() => {
            clipboardRef.current = canvasRef.current?.copySelection() || canvasRef.current?.getImageData() || null;
            canvasRef.current?.deleteSelection();
          }}
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
            {/* Animation tabs */}
            <div style={{ marginBottom: '1rem' }}>
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
                    {ANIMATION_STATE_LABELS[as]} ({frameCounts[as]})
                  </button>
                ))}
              </div>
            </div>

            {/* Direction tabs */}
            <div style={{ marginBottom: '1rem' }}>
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

            {/* Frame selector with Add/Duplicate buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ color: '#666', fontSize: '0.75rem' }}>Frame:</span>
              {Array.from({ length: currentFrameCount }, (_, i) => (
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

              {/* Add Frame button */}
              <button
                onClick={addFrame}
                disabled={currentFrameCount >= MAX_FRAMES}
                title="Add Frame"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '4px',
                  background: currentFrameCount >= MAX_FRAMES ? '#333' : '#16213e',
                  color: currentFrameCount >= MAX_FRAMES ? '#555' : '#4ecca3',
                  cursor: currentFrameCount >= MAX_FRAMES ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Plus size={16} />
              </button>

              {/* Duplicate Frame button */}
              <button
                onClick={duplicateFrame}
                disabled={currentFrameCount >= MAX_FRAMES}
                title="Duplicate Frame"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '4px',
                  background: currentFrameCount >= MAX_FRAMES ? '#333' : '#16213e',
                  color: currentFrameCount >= MAX_FRAMES ? '#555' : '#ffd93d',
                  cursor: currentFrameCount >= MAX_FRAMES ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Copy size={16} />
              </button>

              {/* Delete Frame button */}
              <button
                onClick={deleteFrame}
                disabled={currentFrameCount <= 1}
                title="Delete Frame"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '4px',
                  background: currentFrameCount <= 1 ? '#333' : '#16213e',
                  color: currentFrameCount <= 1 ? '#555' : '#ff6b6b',
                  cursor: currentFrameCount <= 1 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Trash2 size={16} />
              </button>

              <div style={{ width: 1, height: 24, background: '#333', margin: '0 0.25rem' }} />

              {/* Move Frame Left button */}
              <button
                onClick={moveFrameLeft}
                disabled={frame <= 0}
                title="Move Frame Left"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '4px',
                  background: frame <= 0 ? '#333' : '#16213e',
                  color: frame <= 0 ? '#555' : '#ccc',
                  cursor: frame <= 0 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ChevronLeft size={16} />
              </button>

              {/* Move Frame Right button */}
              <button
                onClick={moveFrameRight}
                disabled={frame >= currentFrameCount - 1}
                title="Move Frame Right"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '4px',
                  background: frame >= currentFrameCount - 1 ? '#333' : '#16213e',
                  color: frame >= currentFrameCount - 1 ? '#555' : '#ccc',
                  cursor: frame >= currentFrameCount - 1 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ChevronRight size={16} />
              </button>

              <div style={{ width: 1, height: 24, background: '#333', margin: '0 0.5rem' }} />

              <button
                onClick={() => setIsPlaying(!isPlaying)}
                title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '4px',
                  background: '#16213e',
                  color: isPlaying ? '#ff6b6b' : '#4ecca3',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
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
                  onZoomChange={setZoom}
                  tool={tool}
                  color={color}
                  brushSize={brushSize}
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
                    width: SPRITE_WIDTH * 2,
                    height: SPRITE_HEIGHT * 2,
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
                      animationState,
                      direction,
                      isPlaying ? previewFrame : frame
                    )}
                    width={SPRITE_WIDTH}
                    height={SPRITE_HEIGHT}
                    scale={2}
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
