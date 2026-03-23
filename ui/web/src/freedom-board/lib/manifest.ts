import { ASSETS_URL } from '../../lib/config';

/**
 * Tile metadata from manifest.json, matching the bake-atlases output format.
 * Extended with atlas info for sprite preview rendering in AssetPanel.
 */
export interface TileDefinition {
  id: string;
  name: string;
  variations: number;
  hasTransitions: boolean;
  tileType: string;    // "TILE" | "PATH" | "BRIDGE"
  terrainType: string; // "LAND" | "WATER"
  /** Relative path to atlas image (e.g. "tiles/iarba.png"). */
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
}

/**
 * Character metadata from manifest.json.
 * Preview uses first frame (row 0, col 0) of the atlas.
 */
export interface CharacterDefinition {
  id: string;
  name: string;
  atlas: string;
  spriteSize: number;
  /** Equipped weapon ID (from editor). */
  weaponDefId?: string;
  /** Equipped throwable/ranged object ID (from editor). */
  throwableDefId?: string;
}

/**
 * Weapon/object metadata from manifest.json.
 * Preview uses first frame (row 0, col 0) of the atlas.
 */
export interface WeaponDefinition {
  id: string;
  name: string;
  atlas: string;
  spriteSize: number;
}

/**
 * Raw manifest.json shape — only the fields we parse.
 */
interface Manifest {
  tiles: Record<string, {
    id: string;
    name: string;
    atlas: string;
    atlasWidth: number;
    atlasHeight: number;
    spriteSize: number;
    variations: number;
    hasTransitions?: boolean;
    tileType?: string;
    terrainType?: string;
    bridgeAssetId?: string;
    passable?: boolean;
    movementCost?: number;
  }>;
  characters?: Record<string, {
    id: string;
    name: string;
    atlas: string;
    atlasWidth: number;
    atlasHeight: number;
    spriteSize: number;
    weaponDefId?: string;
    throwableDefId?: string;
  }>;
  weapons?: Record<string, {
    id: string;
    name: string;
    atlas: string;
    atlasWidth: number;
    atlasHeight: number;
    spriteSize: number;
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
  passable: boolean;      // Can characters walk on this tile?
  movementCost: number;   // 1-100, lower = easier to traverse. Default 10.
}

/**
 * Load manifest.json and extract tile definitions, characters, and weapons.
 * Returns tiles sorted alphabetically by id for deterministic asset_id assignment.
 */
export async function loadTileManifest(): Promise<{
  tiles: TileDefinition[];
  registry: TileRegistryEntry[];
  characters: CharacterDefinition[];
  weapons: WeaponDefinition[];
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
      atlas: t.atlas,
      atlasWidth: t.atlasWidth,
      atlasHeight: t.atlasHeight,
      spriteSize: t.spriteSize,
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
      passable: t.passable ?? (t.terrainType !== 'WATER'),
      movementCost: t.movementCost ?? 10,
    };
    if (t.bridgeAssetId) {
      entry.bridgeAssetId = t.bridgeAssetId;
    }
    return entry;
  });

  // Characters — sorted by id for consistency
  const characters: CharacterDefinition[] = Object.keys(manifest.characters ?? {}).sort().map(id => {
    const c = manifest.characters![id];
    return {
      id: c.id,
      name: c.name,
      atlas: c.atlas,
      spriteSize: c.spriteSize,
      ...(c.weaponDefId ? { weaponDefId: c.weaponDefId } : {}),
      ...(c.throwableDefId ? { throwableDefId: c.throwableDefId } : {}),
    };
  });

  // Weapons — sorted by id for consistency
  const weapons: WeaponDefinition[] = Object.keys(manifest.weapons ?? {}).sort().map(id => {
    const w = manifest.weapons![id];
    return { id: w.id, name: w.name, atlas: w.atlas, spriteSize: w.spriteSize };
  });

  return { tiles, registry, characters, weapons };
}
