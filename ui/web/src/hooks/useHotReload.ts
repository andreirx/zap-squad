import { useState, useCallback } from 'react';
import { createStorage } from '../storage';
import { packAllSprites, savePackedAssets, type ZapManifest } from '../utils/spritePacker';

interface HotReloadCallbacks {
  onReloadStart?: () => void;
  onReloadComplete?: (data: ReloadedData) => void;
  onReloadError?: (error: Error) => void;
  onPackStart?: () => void;
  onPackComplete?: () => void;
}

export interface ReloadedData {
  scripts: Record<string, string>;
  levels: string[];
  gameManifest: GameManifest;
  spriteManifest: ZapManifest;
}

/** Game manifest for actor/weapon definitions (used by Rust) */
interface GameManifest {
  bodies: Record<string, BodyDefinition>;
  weapons: Record<string, WeaponDefinition>;
}

interface BodyDefinition {
  id: string;
  name: string;
  frames_per_state: number;
  frame_duration: number;
}

interface WeaponDefinition {
  id: string;
  name: string;
  weapon_type: string;
  frames_per_state: number;
  frame_duration: number;
}

export function useHotReload(callbacks?: HotReloadCallbacks) {
  const [isReloading, setIsReloading] = useState(false);
  const [isPacking, setIsPacking] = useState(false);
  const [lastReloadTime, setLastReloadTime] = useState<Date | null>(null);
  const [reloadedData, setReloadedData] = useState<ReloadedData | null>(null);

  /**
   * Pack sprites into atlases without full reload
   */
  const packSprites = useCallback(async () => {
    setIsPacking(true);
    callbacks?.onPackStart?.();

    try {
      console.log('Packing sprites...');
      const result = await packAllSprites();
      await savePackedAssets(result);
      console.log('Sprite packing complete');
      callbacks?.onPackComplete?.();
      return result.manifest;
    } catch (error) {
      console.error('Sprite packing failed:', error);
      throw error;
    } finally {
      setIsPacking(false);
    }
  }, [callbacks]);

  /**
   * Full reload: pack sprites + load scripts + load levels
   */
  const reload = useCallback(async () => {
    setIsReloading(true);
    callbacks?.onReloadStart?.();

    try {
      const storage = createStorage();

      // Step 1: Pack sprites into atlases
      console.log('Step 1: Packing sprites...');
      const spriteManifest = await packSprites();

      // Step 2: Load all scripts
      console.log('Step 2: Loading scripts...');
      const scriptFiles = await storage.list('scripts');
      const scripts: Record<string, string> = {};

      for (const file of scriptFiles) {
        if (file.endsWith('.rhai')) {
          const name = file.replace('scripts/', '').replace('.rhai', '');
          scripts[name] = await storage.readText(file);
        }
      }

      // Step 3: Load all levels
      console.log('Step 3: Loading levels...');
      const levelFiles = await storage.list('levels');
      const levels = levelFiles.filter(f => f.endsWith('.json'));

      // Step 4: Build game manifest from definitions
      console.log('Step 4: Building game manifest...');
      const gameManifest = await buildGameManifest(storage);

      const data: ReloadedData = { scripts, levels, gameManifest, spriteManifest };

      setReloadedData(data);
      setLastReloadTime(new Date());
      callbacks?.onReloadComplete?.(data);

      console.log('Hot reload complete:', {
        scripts: Object.keys(scripts).length,
        levels: levels.length,
        bodies: Object.keys(gameManifest.bodies).length,
        weapons: Object.keys(gameManifest.weapons).length,
        atlases: spriteManifest.atlases.length,
        sprites: Object.keys(spriteManifest.sprites).length,
      });

      return data;
    } catch (error) {
      callbacks?.onReloadError?.(error as Error);
      console.error('Hot reload failed:', error);
      throw error;
    } finally {
      setIsReloading(false);
    }
  }, [callbacks, packSprites]);

  return {
    reload,
    packSprites,
    isReloading,
    isPacking,
    lastReloadTime,
    reloadedData,
  };
}

async function buildGameManifest(storage: ReturnType<typeof createStorage>): Promise<GameManifest> {
  const manifest: GameManifest = {
    bodies: {},
    weapons: {},
  };

  // Load character definitions
  const characterDirs = await storage.list('characters');
  const characterIds = [...new Set(
    characterDirs
      .filter(f => f.includes('/'))
      .map(f => f.split('/')[1])
  )];

  for (const id of characterIds) {
    try {
      const defJson = await storage.readText(`characters/${id}/definition.json`);
      const def = JSON.parse(defJson);
      manifest.bodies[id] = {
        id,
        name: def.name || id,
        frames_per_state: def.frames || 4,
        frame_duration: def.frameDuration || 0.1,
      };
    } catch {
      // Skip invalid definitions
    }
  }

  // Load weapon definitions
  const weaponDirs = await storage.list('weapons');
  const weaponIds = [...new Set(
    weaponDirs
      .filter(f => f.includes('/'))
      .map(f => f.split('/')[1])
  )];

  for (const id of weaponIds) {
    try {
      const defJson = await storage.readText(`weapons/${id}/definition.json`);
      const def = JSON.parse(defJson);
      manifest.weapons[id] = {
        id,
        name: def.name || id,
        weapon_type: def.weaponType || 'melee',
        frames_per_state: def.frames || 4,
        frame_duration: def.frameDuration || 0.1,
      };
    } catch {
      // Skip invalid definitions
    }
  }

  return manifest;
}
