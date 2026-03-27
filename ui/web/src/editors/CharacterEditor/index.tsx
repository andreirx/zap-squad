import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, Copy, Trash2, ChevronLeft, ChevronRight, Play, Pause, Upload } from 'lucide-react';
import { PixelCanvas, type PixelCanvasRef } from '../PixelCanvas';
import { ColorPicker } from '../ColorPicker';
import { Toolbar } from '../Toolbar';
import { createStorage } from '../../storage';
import { importImageToImageData } from '../importImage';
import { bakeCharacter } from '../../lib/character-baker';
import { emitCharacterAssetsChanged } from '../../lib/asset-events';
import type {
  CharacterSourceDef,
  AnimationDirections,
  DirectionFrames,
} from '../../schemas/character';
import { framePath as schemaFramePath } from '../../schemas/character';
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

/** Legacy definition format (pre-schema). Detected by absence of `version` field. */
interface LegacyCharacterDefinition {
  id: string;
  name: string;
  frameDuration: number;
  weaponDefId?: string;
  throwableDefId?: string;
  createdAt?: string;
  updatedAt?: string;
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

  // Frame counts per animation+direction. Key: `${animation}_${direction}`.
  // Each animation+direction pair has an independent frame count.
  // Frame operations never cross direction boundaries.
  const [frameCounts, setFrameCounts] = useState<Record<string, number>>({});

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

  // Last loaded CharacterSourceDef — used to preserve custom animations
  // that the editor doesn't author but should not destroy on save.
  const loadedDefRef = useRef<CharacterSourceDef | null>(null);

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

  // Composite key for current animation+direction
  const frameCountKey = `${animationState}_${direction}`;
  // Current frame count for this specific animation+direction
  const currentFrameCount = frameCounts[frameCountKey] ?? 1;

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
      // Reset frame if exceeds this animation+direction's frame count
      const newKey = `${as}_${direction}`;
      const newFrameCount = frameCounts[newKey] ?? 1;
      if (frame >= newFrameCount) {
        setFrame(0);
      }
    },
    [saveCurrentSprite, frame, direction, frameCounts]
  );

  // Change direction handler
  const changeDirection = useCallback(
    (dir: Direction) => {
      saveCurrentSprite();
      setDirection(dir);
      // Reset frame if exceeds this animation+direction's frame count
      const newKey = `${animationState}_${dir}`;
      const newFrameCount = frameCounts[newKey] ?? 1;
      if (frame >= newFrameCount) {
        setFrame(0);
      }
    },
    [saveCurrentSprite, animationState, frame, frameCounts]
  );

  // Change frame handler
  const changeFrame = useCallback(
    (f: number) => {
      saveCurrentSprite();
      setFrame(f);
    },
    [saveCurrentSprite]
  );

  // Add a new empty frame to current animation+direction (up to MAX_FRAMES)
  const addFrame = useCallback(() => {
    if (currentFrameCount >= MAX_FRAMES) return;
    saveCurrentSprite();
    setFrameCounts(prev => ({ ...prev, [frameCountKey]: currentFrameCount + 1 }));
    setFrame(currentFrameCount); // switch to the new empty frame
  }, [currentFrameCount, frameCountKey, saveCurrentSprite]);

  // Duplicate current frame as a new frame (current animation+direction only)
  const duplicateFrame = useCallback(() => {
    if (currentFrameCount >= MAX_FRAMES) return;
    saveCurrentSprite();

    const sourceData = spritesRef.current.get(currentKey);
    const newFrameIndex = currentFrameCount;

    if (sourceData) {
      const copy = new ImageData(
        new Uint8ClampedArray(sourceData.data),
        sourceData.width,
        sourceData.height
      );
      spritesRef.current.set(getSpriteKey(animationState, direction, newFrameIndex), copy);
    }

    setFrameCounts(prev => ({ ...prev, [frameCountKey]: currentFrameCount + 1 }));
    setFrame(newFrameIndex);
  }, [currentFrameCount, frameCountKey, animationState, direction, currentKey, getSpriteKey, saveCurrentSprite]);

  // Delete current frame (current animation+direction only)
  const deleteFrame = useCallback(() => {
    if (currentFrameCount <= 1) return;
    saveCurrentSprite();

    // Shift frames after the deleted one down — current direction only
    for (let f = frame; f < currentFrameCount - 1; f++) {
      const srcKey = getSpriteKey(animationState, direction, f + 1);
      const destKey = getSpriteKey(animationState, direction, f);
      const srcData = spritesRef.current.get(srcKey);
      if (srcData) {
        spritesRef.current.set(destKey, srcData);
      } else {
        spritesRef.current.delete(destKey);
      }
    }
    // Remove the now-orphaned last slot
    spritesRef.current.delete(getSpriteKey(animationState, direction, currentFrameCount - 1));

    setFrameCounts(prev => ({ ...prev, [frameCountKey]: currentFrameCount - 1 }));
    setFrame(prev => Math.max(0, prev - 1));
  }, [currentFrameCount, frameCountKey, animationState, direction, frame, getSpriteKey, saveCurrentSprite]);

  // Move current frame left
  // Import image from file (PNG/JPG) into current frame
  const handleImportImage = useCallback(async () => {
    console.log('[CharacterEditor] import image requested, animation:', animationState, 'direction:', direction, 'frame:', frame);
    const result = await importImageToImageData(SPRITE_WIDTH);
    if (!result) { console.log('[CharacterEditor] import cancelled or failed'); return; }
    console.log('[CharacterEditor] setting imported image on canvas:', result.fileName);
    canvasRef.current?.setImageData(result.imageData);
    // Commit to spritesRef immediately so the import persists across
    // frame switches and saves. setImageData only updates the canvas
    // buffer — it does not call onChange, so spritesRef would stay stale.
    spritesRef.current.set(currentKey, result.imageData);
  }, [animationState, direction, frame, currentKey]);

  // Move current frame left (current animation+direction only)
  const moveFrameLeft = useCallback(() => {
    if (frame <= 0) return;
    saveCurrentSprite();

    const keyA = getSpriteKey(animationState, direction, frame);
    const keyB = getSpriteKey(animationState, direction, frame - 1);
    const dataA = spritesRef.current.get(keyA);
    const dataB = spritesRef.current.get(keyB);

    if (dataA) spritesRef.current.set(keyB, dataA);
    else spritesRef.current.delete(keyB);
    if (dataB) spritesRef.current.set(keyA, dataB);
    else spritesRef.current.delete(keyA);

    setFrame(frame - 1);
  }, [frame, animationState, direction, getSpriteKey, saveCurrentSprite]);

  // Move current frame right (current animation+direction only)
  const moveFrameRight = useCallback(() => {
    if (frame >= currentFrameCount - 1) return;
    saveCurrentSprite();

    const keyA = getSpriteKey(animationState, direction, frame);
    const keyB = getSpriteKey(animationState, direction, frame + 1);
    const dataA = spritesRef.current.get(keyA);
    const dataB = spritesRef.current.get(keyB);

    if (dataA) spritesRef.current.set(keyB, dataA);
    else spritesRef.current.delete(keyB);
    if (dataB) spritesRef.current.set(keyA, dataB);
    else spritesRef.current.delete(keyA);

    setFrame(frame + 1);
  }, [frame, currentFrameCount, animationState, direction, getSpriteKey, saveCurrentSprite]);

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
        const defJson = await storage.readText(`characters/${id}/definition.json`);
        const raw = JSON.parse(defJson);

        // Detect format: new schema has `version` and `animations` fields
        const isNewFormat = raw.version === 1 && raw.animations;

        spritesRef.current.clear();
        const newFrameCounts: Record<string, number> = {};

        if (isNewFormat) {
          // ── New format: load from CharacterSourceDef ────────────────
          const def = raw as CharacterSourceDef;
          loadedDefRef.current = def;
          setCharacterId(def.id);
          setCharacterName(def.name);
          setFrameDuration(def.frameDuration || DEFAULT_FRAME_DURATION);
          setWeaponDefId(def.weaponDefId || '');
          setThrowableDefId(def.throwableDefId || '');

          for (const [as, animDirs] of Object.entries(def.animations)) {
            for (const dir of DIRECTIONS) {
              const df = animDirs[dir];
              if (!df) continue;
              for (let f = 0; f < df.frames; f++) {
                const path = schemaFramePath(id, as, dir, f);
                try {
                  const url = storage.getReadUrl(path);
                  const img = await loadImage(url);
                  const data = imageToImageData(img, SPRITE_WIDTH, SPRITE_HEIGHT);
                  spritesRef.current.set(getSpriteKey(as as AnimationState, dir, f), data);
                } catch {
                  // Declared frame missing — leave empty (will show blank canvas)
                  console.warn(`[CharacterEditor] declared frame missing: ${path}`);
                }
              }
              newFrameCounts[`${as}_${dir}`] = df.frames;
            }
          }
        } else {
          // ── Legacy format: discovery-based migration ─────────────────
          loadedDefRef.current = null;
          const legacy = raw as LegacyCharacterDefinition;
          setCharacterId(legacy.id || id);
          setCharacterName(legacy.name || id);
          setFrameDuration(legacy.frameDuration || DEFAULT_FRAME_DURATION);
          setWeaponDefId(legacy.weaponDefId || '');
          setThrowableDefId(legacy.throwableDefId || '');

          console.log(`[CharacterEditor] legacy format detected for "${id}", migrating on next save`);

          // Discover frames by scanning for old filename patterns:
          //   {id}_full_{anim}_{dir}_{frame}.png  (old visual-state format)
          //   {id}_{anim}_{dir}_{frame}.png       (intermediate format)
          for (const as of ANIMATION_STATES) {
            for (const dir of DIRECTIONS) {
              let dirFrameCount = 0;
              for (let f = 0; f < MAX_FRAMES; f++) {
                const patterns = [
                  `characters/${id}/${id}_full_${as}_${dir}_${f}.png`,
                  `characters/${id}/${id}_${as}_${dir}_${f}.png`,
                ];
                let loaded = false;
                for (const pattern of patterns) {
                  try {
                    const url = storage.getReadUrl(pattern);
                    const img = await loadImage(url);
                    const data = imageToImageData(img, SPRITE_WIDTH, SPRITE_HEIGHT);
                    spritesRef.current.set(getSpriteKey(as, dir, f), data);
                    dirFrameCount = f + 1;
                    loaded = true;
                    break;
                  } catch {
                    // Try next pattern
                  }
                }
                if (!loaded) break;
              }
              if (dirFrameCount > 0) {
                newFrameCounts[`${as}_${dir}`] = dirFrameCount;
              }
            }
          }
        }

        // Ensure every animation+direction has at least 1 in frameCounts
        // for directions where we found frames
        setFrameCounts(newFrameCounts);

        // Reset to initial state
        setAnimationState('idle');
        setDirection('south');
        setFrame(0);
        loadSprite('idle', 'south', 0);

        if (!isNewFormat) {
          setSaveError('Legacy format — save to migrate to new schema');
        }
      } catch (e) {
        setSaveError(`Failed to load character: ${e}`);
        console.error('[CharacterEditor] load error:', e);
      } finally {
        setIsLoading(false);
      }
    },
    [getSpriteKey, loadSprite]
  );

  // Save character to storage using CharacterSourceDef schema.
  // Authoritative: deletes all existing files for this character first,
  // then writes the definition + declared frame blobs. No orphans survive.
  const saveCharacter = useCallback(async () => {
    if (!characterId.trim()) {
      setSaveError('Character ID is required');
      return;
    }

    // Commit current canvas to spritesRef before building the definition
    saveCurrentSprite();

    setIsSaving(true);
    setSaveError(null);
    try {
      const storage = createStorage();
      const now = new Date().toISOString();

      // Build CharacterSourceDef from editor state.
      // Also preserve any non-standard animations from a previously loaded
      // definition so the editor doesn't destroy data it can't author yet.
      const animations: Record<string, AnimationDirections> = {};
      const droppedWarnings: string[] = [];

      for (const as of ANIMATION_STATES) {
        const dirs: Partial<Record<Direction, DirectionFrames>> = {};
        let hasAnyDirection = false;
        for (const dir of DIRECTIONS) {
          const fcKey = `${as}_${dir}`;
          const fc = frameCounts[fcKey] ?? 0;
          const hasContent = fc > 0 && Array.from({ length: fc }, (_, f) =>
            spritesRef.current.has(getSpriteKey(as, dir, f))
          ).some(Boolean);
          if (hasContent) {
            dirs[dir] = { frames: fc, loop: !as.includes('attack') };
            hasAnyDirection = true;
          }
        }
        if (hasAnyDirection) {
          if (!dirs.south) {
            // Has work in other directions but no south — warn, don't silently drop
            droppedWarnings.push(`"${as}" has no south frames and will not be saved (schema requires south)`);
            continue;
          }
          animations[as] = {
            south: dirs.south!,
            north: dirs.north,
            east: dirs.east,
            west: dirs.west,
          };
        }
      }

      // Preserve non-standard animations from the loaded definition.
      // The editor can only author the 4 standard states; custom animations
      // pass through unchanged so save doesn't destroy them.
      if (loadedDefRef.current) {
        for (const [key, value] of Object.entries(loadedDefRef.current.animations)) {
          if (!ANIMATION_STATES.includes(key as AnimationState) && !animations[key]) {
            animations[key] = value;
          }
        }
      }

      if (droppedWarnings.length > 0) {
        const proceed = window.confirm(
          'Some animations will not be saved:\n\n' +
          droppedWarnings.join('\n') +
          '\n\nContinue saving?'
        );
        if (!proceed) {
          setIsSaving(false);
          return;
        }
      }

      const def: CharacterSourceDef = {
        version: 1,
        id: characterId,
        name: characterName || characterId,
        spriteSize: SPRITE_WIDTH,
        frameDuration,
        weaponDefId: weaponDefId || null,
        throwableDefId: throwableDefId || null,
        animations,
        createdAt: loadedDefRef.current?.createdAt ?? now,
        updatedAt: now,
      };

      // Validate before any destructive operation
      const { validateSourceDef } = await import('../../schemas/character');
      const validationErrors = validateSourceDef(def);
      if (validationErrors.length > 0) {
        setSaveError('Validation failed:\n' + validationErrors.join('\n'));
        setIsSaving(false);
        return;
      }

      // Delete ALL existing files for this character (authoritative save).
      // This removes orphaned frames from previous saves, legacy format
      // files, and any stale data that would confuse future loads.
      const prefix = `characters/${characterId}/`;
      const existingFiles = await storage.list(prefix);
      for (const file of existingFiles) {
        await storage.delete(file);
      }

      // Write definition
      await storage.writeText(
        `characters/${characterId}/definition.json`,
        JSON.stringify(def, null, 2)
      );

      // Write frame blobs to stable logical paths
      let written = 0;
      for (const [as, animDirs] of Object.entries(animations)) {
        for (const dir of DIRECTIONS) {
          const df = animDirs[dir];
          if (!df) continue;
          for (let f = 0; f < df.frames; f++) {
            const spriteData = spritesRef.current.get(getSpriteKey(as as AnimationState, dir as Direction, f));
            if (spriteData) {
              const blob = await imageDataToPng(spriteData);
              const path = schemaFramePath(characterId, as, dir, f);
              await storage.writeBytes(path, await blob.arrayBuffer(), 'image/png');
              written++;
            }
          }
        }
      }

      // Update existing characters list
      if (!existingCharacters.includes(characterId)) {
        setExistingCharacters([...existingCharacters, characterId]);
      }

      // Save establishes the authoritative source definition.
      // Bake is a derived-cache step required for Freedom Board rendering.
      const bakeResult = await bakeCharacter(characterId);
      loadedDefRef.current = def;
      if (!bakeResult.success) {
        setSaveError(
          `Saved source definition, but bake failed:\n${bakeResult.errors.join('\n')}`
        );
        return;
      }

      emitCharacterAssetsChanged({
        characterId,
        bakedAt: now,
      });

      console.log(`[CharacterEditor] saved ${characterId}: ${written} frames, ${Object.keys(animations).length} animations`);
    } catch (e) {
      setSaveError(`Failed to save: ${e}`);
      console.error('[CharacterEditor] save error:', e);
    } finally {
      setIsSaving(false);
    }
  }, [characterId, characterName, frameDuration, weaponDefId, throwableDefId,
      frameCounts, saveCurrentSprite, existingCharacters, getSpriteKey]);

  // Copy current frame to all directions (explicit user action).
  // Ensures target directions have enough frames to hold the copied frame.
  const copyToAllDirections = useCallback(() => {
    saveCurrentSprite();
    const sourceData = spritesRef.current.get(currentKey);
    if (!sourceData) return;

    const updates: Record<string, number> = {};
    for (const dir of DIRECTIONS) {
      if (dir !== direction) {
        const key = getSpriteKey(animationState, dir, frame);
        const copy = new ImageData(
          new Uint8ClampedArray(sourceData.data),
          sourceData.width,
          sourceData.height
        );
        spritesRef.current.set(key, copy);
        // Ensure target direction has enough frames
        const targetKey = `${animationState}_${dir}`;
        const targetCount = frameCounts[targetKey] ?? 1;
        if (frame >= targetCount) {
          updates[targetKey] = frame + 1;
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      setFrameCounts(prev => ({ ...prev, ...updates }));
    }
  }, [currentKey, direction, animationState, frame, frameCounts, getSpriteKey, saveCurrentSprite]);

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
    setWeaponDefId('');
    setThrowableDefId('');
    setFrameCounts({ idle_south: 1 });
    setFrameDuration(DEFAULT_FRAME_DURATION);
    spritesRef.current.clear();
    loadedDefRef.current = null;
    canvasRef.current?.clear();
    setAnimationState('idle');
    setDirection('south');
    setFrame(0);
    setSaveError(null);
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
                    {ANIMATION_STATE_LABELS[as]} ({frameCounts[`${as}_${direction}`] ?? 0})
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

              {/* Import image from file */}
              <button
                onClick={handleImportImage}
                title="Import image from file (PNG/JPG)"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '4px',
                  background: '#16213e',
                  color: '#60a0e0',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Upload size={16} />
              </button>

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
