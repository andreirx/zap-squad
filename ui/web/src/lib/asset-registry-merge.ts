/**
 * Asset registry merge — combines seed assets with user-baked characters.
 *
 * Loads the seed manifest (assets_feathered.json), then reads all baked
 * character outputs from IDB and merges them into a single AssetManifest
 * + atlas blob map that useZapEngine can consume directly.
 *
 * This module is the bridge between:
 *   - Seed assets (static files served by Vite/CDN)
 *   - User-baked characters (in IDB, produced by character-baker.ts)
 *   - The zap-engine runtime (useZapEngine hook)
 */

import { fileStore } from './idb';
import {
  listBakedCharacters,
  readBakedDef,
  readBakedSpriteEntries,
} from './character-baker';

// ── Types ─────────────────────────────────────────────────────────────

// Re-export zap-engine's AssetManifest so types align exactly.
// Cannot import directly because @zap/web exports from index.ts,
// and the manifest types may not be re-exported from the react entry.
// Use a structural match that satisfies the engine's interface.
interface AssetManifest {
  atlases: Array<{ name: string; cols: number; rows: number; path: string }>;
  sprites: Record<string, { atlas: number; col: number; row: number }>;
  sounds?: Record<string, { path: string; event_id?: number }>;
}

/** Everything useZapEngine needs for init. */
export interface MergedAssetRegistry {
  /** Manifest with seed + user-baked entries merged. */
  manifest: AssetManifest;
  /** Additional atlas blobs from IDB (user-baked). Keyed by atlas name. */
  extraAtlasBlobs: Map<string, Blob>;
  /** IDs of user-baked characters that were merged. */
  bakedCharacterIds: string[];
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Load the seed manifest and merge all user-baked characters from IDB.
 *
 * @param seedManifestUrl URL to assets_feathered.json
 * @returns Merged manifest + extra atlas blobs for useZapEngine
 */
export async function loadMergedRegistry(
  seedManifestUrl: string,
): Promise<MergedAssetRegistry> {
  // 1. Load seed manifest
  const resp = await fetch(seedManifestUrl);
  if (!resp.ok) {
    throw new Error(`Failed to load seed manifest: HTTP ${resp.status}`);
  }
  const manifest: AssetManifest = await resp.json();
  const extraAtlasBlobs = new Map<string, Blob>();
  const bakedCharacterIds: string[] = [];

  // 2. Discover baked characters in IDB
  let bakedIds: string[];
  try {
    bakedIds = await listBakedCharacters();
  } catch (err) {
    console.warn('[registry-merge] failed to list baked characters:', err);
    return { manifest, extraAtlasBlobs, bakedCharacterIds };
  }

  if (bakedIds.length === 0) {
    return { manifest, extraAtlasBlobs, bakedCharacterIds };
  }

  // 3. For each baked character, merge atlas + sprite entries
  for (const id of bakedIds) {
    try {
      const [bakedDef, spriteEntries, atlasRecord] = await Promise.all([
        readBakedDef(id),
        readBakedSpriteEntries(id),
        fileStore.load(`baked/characters/${id}/atlas.png`),
      ]);

      if (!bakedDef || !spriteEntries || !atlasRecord) {
        console.warn(`[registry-merge] incomplete baked data for "${id}", skipping`);
        continue;
      }

      // Add atlas descriptor to manifest
      const atlasName = `baked_characters_${id}`;
      const atlasIndex = manifest.atlases.length;
      manifest.atlases.push({
        name: atlasName,
        cols: (bakedDef as Record<string, number>).atlasWidth / (bakedDef as Record<string, number>).spriteSize,
        rows: (bakedDef as Record<string, number>).atlasHeight / (bakedDef as Record<string, number>).spriteSize,
        // Path is not used for IDB blobs — the blob is provided via extraAtlasBlobs.
        // The renderer resolves by atlas name, not path, when blobs are pre-loaded.
        path: `baked/characters/${id}/atlas.png`,
      });

      // Merge sprite entries with corrected atlas index.
      // The baker stored entries with atlas=0 (placeholder).
      // We reassign to the actual index in the merged manifest.
      for (const [key, entry] of Object.entries(spriteEntries)) {
        manifest.sprites[key] = {
          atlas: atlasIndex,
          col: entry.col,
          row: entry.row,
        };
      }

      // Load atlas blob for the renderer
      const blob = new Blob([atlasRecord.data], { type: 'image/png' });
      extraAtlasBlobs.set(atlasName, blob);

      bakedCharacterIds.push(id);
      console.log(
        `[registry-merge] merged "${id}": atlas=${atlasIndex}, ` +
        `${Object.keys(spriteEntries).length} sprites`
      );
    } catch (err) {
      console.warn(`[registry-merge] failed to merge "${id}":`, err);
    }
  }

  if (bakedCharacterIds.length > 0) {
    console.log(
      `[registry-merge] merged ${bakedCharacterIds.length} baked character(s) ` +
      `into manifest (${manifest.atlases.length} atlases, ` +
      `${Object.keys(manifest.sprites).length} sprites total)`
    );
  }

  return { manifest, extraAtlasBlobs, bakedCharacterIds };
}
