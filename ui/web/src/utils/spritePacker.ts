/**
 * Browser-based sprite packer
 *
 * Packs individual PNG files into sprite sheet atlases using Canvas API.
 * This runs in the browser and generates base64 PNG data that can be
 * sent to the Vite dev server for writing to disk.
 */

import { createStorage } from '../storage';

// ============================================================================
// Types
// ============================================================================

export interface PackedAtlas {
  name: string;
  filename: string;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  dataUrl: string; // base64 PNG
  sprites: Map<string, { col: number; row: number }>;
}

export interface ZapManifest {
  atlases: {
    name: string;
    cols: number;
    rows: number;
    path: string;
  }[];
  sprites: Record<string, { atlas: number; col: number; row: number }>;
  sounds: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const SPRITE_SIZE = 128;
const TILE_SIZE = 128;

const VISUAL_STATES = ['full', 'hurt_1', 'hurt_2', 'critical'] as const;
const ANIMATION_STATES = ['idle', 'walk', 'melee_attack', 'throw_attack'] as const;
const DIRECTIONS = ['north', 'east', 'south', 'west'] as const;
const FRAMES_PER_ANIM = 4;

// ============================================================================
// Helpers
// ============================================================================

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

// ============================================================================
// Character Packing
// ============================================================================

export async function packCharacter(charId: string): Promise<PackedAtlas | null> {
  const storage = createStorage();
  const sprites = new Map<string, { col: number; row: number }>();
  const cols = 16;
  const rows = 16;

  const canvas = document.createElement('canvas');
  canvas.width = cols * SPRITE_SIZE;
  canvas.height = rows * SPRITE_SIZE;
  const ctx = canvas.getContext('2d')!;

  let hasAnySprite = false;

  for (let vi = 0; vi < VISUAL_STATES.length; vi++) {
    const visual = VISUAL_STATES[vi];

    for (let ai = 0; ai < ANIMATION_STATES.length; ai++) {
      const anim = ANIMATION_STATES[ai];
      const row = vi * 4 + ai;

      for (let di = 0; di < DIRECTIONS.length; di++) {
        const dir = DIRECTIONS[di];

        for (let frame = 0; frame < FRAMES_PER_ANIM; frame++) {
          const col = di * 4 + frame;
          const filename = `${charId}_${visual}_${anim}_${dir}_${frame}.png`;
          const filepath = `characters/${charId}/${filename}`;

          try {
            const url = storage.getReadUrl(filepath);
            const img = await loadImage(url);
            ctx.drawImage(img, col * SPRITE_SIZE, row * SPRITE_SIZE, SPRITE_SIZE, SPRITE_SIZE);
            hasAnySprite = true;
          } catch {
            // Sprite doesn't exist
          }

          const spriteName = `${charId}_${visual}_${anim}_${dir}_${frame}`;
          sprites.set(spriteName, { col, row });
        }
      }
    }
  }

  if (!hasAnySprite) return null;

  return {
    name: `characters_${charId}`,
    filename: `characters_${charId}_${cols}x${rows}.png`,
    cols,
    rows,
    cellWidth: SPRITE_SIZE,
    cellHeight: SPRITE_SIZE,
    dataUrl: canvas.toDataURL('image/png'),
    sprites,
  };
}

// ============================================================================
// Weapon Packing
// ============================================================================

export async function packWeapon(weaponId: string): Promise<PackedAtlas | null> {
  const storage = createStorage();
  const sprites = new Map<string, { col: number; row: number }>();
  const cols = 16;
  const rows = 4;

  const canvas = document.createElement('canvas');
  canvas.width = cols * SPRITE_SIZE;
  canvas.height = rows * SPRITE_SIZE;
  const ctx = canvas.getContext('2d')!;

  let hasAnySprite = false;

  for (let ai = 0; ai < ANIMATION_STATES.length; ai++) {
    const anim = ANIMATION_STATES[ai];
    const row = ai;

    for (let di = 0; di < DIRECTIONS.length; di++) {
      const dir = DIRECTIONS[di];

      for (let frame = 0; frame < FRAMES_PER_ANIM; frame++) {
        const col = di * 4 + frame;
        const filename = `${weaponId}_${anim}_${dir}_${frame}.png`;
        const filepath = `weapons/${weaponId}/${filename}`;

        try {
          const url = storage.getReadUrl(filepath);
          const img = await loadImage(url);
          ctx.drawImage(img, col * SPRITE_SIZE, row * SPRITE_SIZE, SPRITE_SIZE, SPRITE_SIZE);
          hasAnySprite = true;
        } catch {
          // Sprite doesn't exist
        }

        const spriteName = `${weaponId}_${anim}_${dir}_${frame}`;
        sprites.set(spriteName, { col, row });
      }
    }
  }

  if (!hasAnySprite) return null;

  return {
    name: `weapons_${weaponId}`,
    filename: `weapons_${weaponId}_${cols}x${rows}.png`,
    cols,
    rows,
    cellWidth: SPRITE_SIZE,
    cellHeight: SPRITE_SIZE,
    dataUrl: canvas.toDataURL('image/png'),
    sprites,
  };
}

// ============================================================================
// Tile Packing
// ============================================================================

export async function packTiles(tileIds: string[]): Promise<PackedAtlas | null> {
  if (tileIds.length === 0) return null;

  const storage = createStorage();
  const sprites = new Map<string, { col: number; row: number }>();

  const count = tileIds.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_SIZE;
  canvas.height = rows * TILE_SIZE;
  const ctx = canvas.getContext('2d')!;

  let hasAnySprite = false;
  let index = 0;

  for (const tileId of tileIds.sort()) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const filepath = `tiles/${tileId}/sprite.png`;

    try {
      const url = storage.getReadUrl(filepath);
      const img = await loadImage(url);
      ctx.drawImage(img, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      hasAnySprite = true;
    } catch {
      // Sprite doesn't exist
    }

    sprites.set(`tile_${tileId}`, { col, row });
    index++;
  }

  if (!hasAnySprite) return null;

  return {
    name: 'tiles',
    filename: `tiles_${cols}x${rows}.png`,
    cols,
    rows,
    cellWidth: TILE_SIZE,
    cellHeight: TILE_SIZE,
    dataUrl: canvas.toDataURL('image/png'),
    sprites,
  };
}

// ============================================================================
// Manifest Generation
// ============================================================================

export function generateManifest(atlases: PackedAtlas[]): ZapManifest {
  const manifest: ZapManifest = {
    atlases: [],
    sprites: {},
    sounds: {},
  };

  for (let i = 0; i < atlases.length; i++) {
    const atlas = atlases[i];

    manifest.atlases.push({
      name: atlas.name,
      cols: atlas.cols,
      rows: atlas.rows,
      path: atlas.filename,
    });

    for (const [spriteName, pos] of atlas.sprites) {
      manifest.sprites[spriteName] = {
        atlas: i,
        col: pos.col,
        row: pos.row,
      };
    }
  }

  return manifest;
}

// ============================================================================
// Full Pack Pipeline
// ============================================================================

export interface PackResult {
  atlases: PackedAtlas[];
  manifest: ZapManifest;
}

export async function packAllSprites(): Promise<PackResult> {
  const storage = createStorage();
  const atlases: PackedAtlas[] = [];

  // Find all characters
  const charFiles = await storage.list('characters');
  const charIds = [...new Set(
    charFiles
      .filter(f => f.includes('/') && f.endsWith('.png'))
      .map(f => f.split('/')[1])
  )];

  console.log(`Packing ${charIds.length} characters...`);
  for (const charId of charIds) {
    const atlas = await packCharacter(charId);
    if (atlas) {
      atlases.push(atlas);
      console.log(`  Packed: ${charId}`);
    }
  }

  // Find all weapons
  const weaponFiles = await storage.list('weapons');
  const weaponIds = [...new Set(
    weaponFiles
      .filter(f => f.includes('/') && f.endsWith('.png'))
      .map(f => f.split('/')[1])
  )];

  console.log(`Packing ${weaponIds.length} weapons...`);
  for (const weaponId of weaponIds) {
    const atlas = await packWeapon(weaponId);
    if (atlas) {
      atlases.push(atlas);
      console.log(`  Packed: ${weaponId}`);
    }
  }

  // Find all tiles
  const tileFiles = await storage.list('tiles');
  const tileIds = [...new Set(
    tileFiles
      .filter(f => f.includes('/definition.json'))
      .map(f => f.split('/')[1])
  )];

  console.log(`Packing ${tileIds.length} tiles...`);
  const tilesAtlas = await packTiles(tileIds);
  if (tilesAtlas) {
    atlases.push(tilesAtlas);
    console.log(`  Packed tiles atlas`);
  }

  const manifest = generateManifest(atlases);

  console.log(`Generated manifest: ${manifest.atlases.length} atlases, ${Object.keys(manifest.sprites).length} sprites`);

  return { atlases, manifest };
}

// ============================================================================
// Save to Storage
// ============================================================================

export async function savePackedAssets(result: PackResult): Promise<void> {
  const storage = createStorage();

  // Save atlas images
  for (const atlas of result.atlases) {
    // Convert data URL to binary
    const base64 = atlas.dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    await storage.writeBytes(`assets/${atlas.filename}`, bytes.buffer, 'image/png');
    console.log(`Saved: assets/${atlas.filename}`);
  }

  // Save manifest
  await storage.writeText('assets/assets.json', JSON.stringify(result.manifest, null, 2));
  console.log('Saved: assets/assets.json');
}
