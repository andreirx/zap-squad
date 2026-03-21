import { ASSETS_URL } from '../config';

/**
 * Tile metadata from manifest.json, matching the bake-atlases output format.
 */
export interface TileDefinition {
  id: string;
  name: string;
  variations: number;
  hasTransitions: boolean;
  tileType: string;    // "TILE" | "PATH" | "BRIDGE" | "TRANSITION" | "WATER"
  terrainType: string; // "LAND" | "WATER"
}

/**
 * The subset of manifest.json we care about.
 */
interface Manifest {
  tiles: Record<string, {
    id: string;
    name: string;
    variations: number;
    hasTransitions?: boolean;
    tileType?: string;
    terrainType?: string;
    bridgeAssetId?: string;
  }>;
}

/**
 * Tile entry for the WASM registry. Array index = asset_id (u16).
 * Includes tile type metadata for path connectivity and bridge auto-placement.
 */
export interface TileRegistryEntry {
  name: string;
  variations: number;
  tileType: string;       // "TILE" | "PATH" | "BRIDGE"
  terrainType: string;    // "LAND" | "WATER"
  bridgeAssetId?: string; // For LAND PATH: which bridge asset to use
}

/**
 * Load manifest.json and extract tile definitions.
 * Returns tiles sorted alphabetically by id for deterministic asset_id assignment.
 */
export async function loadTileManifest(): Promise<{
  tiles: TileDefinition[];
  registry: TileRegistryEntry[];
}> {
  const url = `${ASSETS_URL}/manifest.json`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch manifest: ${resp.status} ${resp.statusText} (${url})`);
  }

  const manifest: Manifest = await resp.json();

  // Sort alphabetically for deterministic u16 assignment.
  // Both React and WASM must use the same ordering.
  const sortedIds = Object.keys(manifest.tiles).sort();

  const tiles: TileDefinition[] = sortedIds.map(id => {
    const t = manifest.tiles[id];
    return {
      id: t.id,
      name: t.name,
      variations: t.variations ?? 1,
      hasTransitions: t.hasTransitions ?? false,
      tileType: t.tileType ?? 'TILE',
      terrainType: t.terrainType ?? 'LAND',
    };
  });

  // Registry for WASM: same order, includes type metadata for path/bridge rendering
  const registry: TileRegistryEntry[] = sortedIds.map(id => {
    const t = manifest.tiles[id];
    const entry: TileRegistryEntry = {
      name: t.id,
      variations: t.variations ?? 1,
      tileType: t.tileType ?? 'TILE',
      terrainType: t.terrainType ?? 'LAND',
    };
    if (t.bridgeAssetId) {
      entry.bridgeAssetId = t.bridgeAssetId;
    }
    return entry;
  });

  return { tiles, registry };
}
