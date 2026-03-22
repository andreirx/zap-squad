/**
 * Runtime feathering pipeline.
 *
 * Loads the wasm-feather WASM module and uses it to convert 128x128 tile
 * atlases into 160x160 feathered atlases at runtime. Results are cached
 * in IndexedDB so the feathering only runs once per atlas.
 *
 * Current usage:
 * - Seed assets ship with pre-baked feathered PNGs (from feather_atlases.py).
 *   The engine loads these via assets_feathered.json — no runtime feathering needed.
 * - User-created tiles (future Phase 8) will NOT have pre-baked versions.
 *   This module feathers them on demand and caches the result in IDB.
 *
 * The featherAtlas() and featherAllAtlases() functions are available for
 * any caller that needs to convert raw 128x128 atlases to 160x160 feathered.
 */

import { fileStore } from './idb';

// Lazy-loaded WASM module
let wasmReady: Promise<void> | null = null;
let featherFn: ((src: Uint8Array, feather: number, edgeAlpha: number) => Uint8Array) | null = null;

/** IDB key prefix for cached feathered atlases. */
const CACHE_PREFIX = 'feathered:';

/** Default feather parameters (must match what the engine expects). */
const DEFAULT_FEATHER = 8;
const DEFAULT_EDGE_ALPHA = 0.8;

/**
 * Initialize the wasm-feather WASM module. Idempotent — only loads once.
 */
async function ensureWasm(): Promise<void> {
  if (wasmReady) return wasmReady;

  wasmReady = (async () => {
    const mod = await import('../wasm-feather/wasm_feather.js');
    await mod.default();
    mod.init_feather();
    featherFn = mod.feather_atlas;
    console.log('[feather] WASM module initialized');
  })();

  return wasmReady;
}

/**
 * Feather a single atlas PNG. Returns a blob URL of the feathered result.
 *
 * Checks IDB cache first. On cache miss, fetches the raw atlas, feathers it
 * via WASM, caches in IDB, and returns a blob URL.
 *
 * @param atlasUrl - URL of the raw 128x128 atlas PNG (e.g., "/assets/tiles/iarba.png")
 * @returns Blob URL of the feathered 160x160 atlas PNG
 */
export async function featherAtlas(atlasUrl: string): Promise<string> {
  const cacheKey = CACHE_PREFIX + atlasUrl;

  // 1. Check IDB cache
  const cached = await fileStore.load(cacheKey);
  if (cached) {
    const blob = new Blob([cached.data], { type: 'image/png' });
    return URL.createObjectURL(blob);
  }

  // 2. Load WASM module
  await ensureWasm();
  if (!featherFn) throw new Error('[feather] WASM module not loaded');

  // 3. Fetch raw atlas
  const resp = await fetch(atlasUrl);
  if (!resp.ok) {
    throw new Error(`[feather] failed to fetch atlas: ${resp.status} ${atlasUrl}`);
  }
  const rawBytes = new Uint8Array(await resp.arrayBuffer());

  // 4. Feather via WASM
  const featheredBytes = featherFn(rawBytes, DEFAULT_FEATHER, DEFAULT_EDGE_ALPHA);

  // 5. Cache in IDB
  await fileStore.save(cacheKey, featheredBytes.buffer as ArrayBuffer, 'image/png');

  // 6. Return blob URL
  const blob = new Blob([new Uint8Array(featheredBytes)], { type: 'image/png' });
  const url = URL.createObjectURL(blob);

  console.log(`[feather] feathered ${atlasUrl} (${rawBytes.length} → ${featheredBytes.length} bytes)`);
  return url;
}

/**
 * Feather all tile atlases from a manifest and return a URL remapping table.
 *
 * Takes the tile definitions (which reference raw atlas paths like "tiles/iarba.png")
 * and produces a Map from original atlas path to feathered blob URL.
 *
 * Character and weapon atlases are NOT feathered — they render at 128x128.
 *
 * @param tiles - Tile definitions from manifest with .atlas field
 * @param assetsUrl - Base URL for assets (e.g., "/assets")
 * @returns Map from original atlas relative path to feathered blob URL
 */
export async function featherAllAtlases(
  tiles: Array<{ atlas: string }>,
  assetsUrl: string,
): Promise<Map<string, string>> {
  // Deduplicate atlas paths (multiple tiles may share an atlas)
  const uniqueAtlases = new Set<string>();
  for (const tile of tiles) {
    uniqueAtlases.add(tile.atlas);
  }

  const urlMap = new Map<string, string>();

  // Process in parallel (limited concurrency to avoid overwhelming the browser)
  const BATCH_SIZE = 4;
  const atlasArray = Array.from(uniqueAtlases);

  for (let i = 0; i < atlasArray.length; i += BATCH_SIZE) {
    const batch = atlasArray.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (atlasPath) => {
        const fullUrl = `${assetsUrl}/${atlasPath}`;
        try {
          const blobUrl = await featherAtlas(fullUrl);
          return { atlasPath, blobUrl };
        } catch (err) {
          console.warn(`[feather] failed to feather ${atlasPath}:`, err);
          // Fall back to raw atlas URL (renders without feathering)
          return { atlasPath, blobUrl: fullUrl };
        }
      }),
    );
    for (const { atlasPath, blobUrl } of results) {
      urlMap.set(atlasPath, blobUrl);
    }
  }

  console.log(`[feather] processed ${urlMap.size} tile atlases`);
  return urlMap;
}

/**
 * Clear all cached feathered atlases from IDB.
 * Useful when source atlases change (e.g., after editing tiles).
 */
export async function clearFeatherCache(): Promise<void> {
  const allKeys = await fileStore.list();
  const featherKeys = allKeys.filter(k => k.startsWith(CACHE_PREFIX));
  for (const key of featherKeys) {
    await fileStore.delete(key);
  }
  console.log(`[feather] cleared ${featherKeys.length} cached atlases`);
}
