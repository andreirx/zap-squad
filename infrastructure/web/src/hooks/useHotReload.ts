import { useState, useCallback } from 'react';
import { createStorage } from '../storage';

interface HotReloadCallbacks {
  onReloadStart?: () => void;
  onReloadComplete?: (data: ReloadedData) => void;
  onReloadError?: (error: Error) => void;
}

interface ReloadedData {
  scripts: Record<string, string>;
  levels: string[];
  manifest: AssetManifest;
}

interface AssetManifest {
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
  const [lastReloadTime, setLastReloadTime] = useState<Date | null>(null);
  const [reloadedData, setReloadedData] = useState<ReloadedData | null>(null);

  const reload = useCallback(async () => {
    setIsReloading(true);
    callbacks?.onReloadStart?.();

    try {
      const storage = createStorage();

      // Load all scripts
      const scriptFiles = await storage.list('scripts');
      const scripts: Record<string, string> = {};

      for (const file of scriptFiles) {
        if (file.endsWith('.rhai')) {
          const name = file.replace('scripts/', '').replace('.rhai', '');
          scripts[name] = await storage.readText(file);
        }
      }

      // Load all levels
      const levelFiles = await storage.list('levels');
      const levels = levelFiles.filter(f => f.endsWith('.json'));

      // Build manifest from character/weapon definitions
      const manifest = await buildManifest(storage);

      const data: ReloadedData = { scripts, levels, manifest };

      setReloadedData(data);
      setLastReloadTime(new Date());
      callbacks?.onReloadComplete?.(data);

      // TODO: Send to WASM worker
      // sendEvent({ type: 'reload_mods', data });

      console.log('Hot reload complete:', {
        scripts: Object.keys(scripts).length,
        levels: levels.length,
        bodies: Object.keys(manifest.bodies).length,
        weapons: Object.keys(manifest.weapons).length,
      });
    } catch (error) {
      callbacks?.onReloadError?.(error as Error);
      console.error('Hot reload failed:', error);
    } finally {
      setIsReloading(false);
    }
  }, [callbacks]);

  return {
    reload,
    isReloading,
    lastReloadTime,
    reloadedData,
  };
}

async function buildManifest(storage: ReturnType<typeof createStorage>): Promise<AssetManifest> {
  const manifest: AssetManifest = {
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
