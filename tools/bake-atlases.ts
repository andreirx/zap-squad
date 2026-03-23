#!/usr/bin/env npx tsx
/**
 * Bake individual sprites into optimized atlases
 *
 * Usage:
 *   npx tsx tools/bake-atlases.ts --input ui/web/public/mods --output ui/web/public/assets
 *
 * Layout:
 *   Characters: 8 columns (frames) × N rows (animations), no visual states
 *   Tiles: variations × (1 base + 8 transitions)
 *   Weapons: 8 columns (frames) × N rows (animations), no visual states
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

// Constants
const MAX_FRAMES = 8;

// Parse arguments
const args = process.argv.slice(2);
let inputDir = '';
let outputDir = '';
let spriteSize = 128;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input' && args[i + 1]) {
    inputDir = args[i + 1];
    i++;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputDir = args[i + 1];
    i++;
  } else if (args[i] === '--size' && args[i + 1]) {
    spriteSize = parseInt(args[i + 1], 10);
    i++;
  }
}

if (!inputDir || !outputDir) {
  console.error('Usage: npx tsx bake-atlases.ts --input <mods_dir> --output <assets_dir> [--size 128]');
  process.exit(1);
}

inputDir = path.resolve(inputDir);
outputDir = path.resolve(outputDir);

console.log(`Input: ${inputDir}`);
console.log(`Output: ${outputDir}`);
console.log(`Sprite size: ${spriteSize}px`);
console.log(`Max frames: ${MAX_FRAMES}`);

// ============================================================================
// Types
// ============================================================================

interface CharacterDefinition {
  id: string;
  name: string;
  frames: number;
  frameDuration: number;
  weaponDefId?: string;
  throwableDefId?: string;
}

interface TileDefinition {
  id: string;
  name: string;
  walkable: boolean;
  passable?: boolean;       // newer alias for walkable
  blocksVision: boolean;
  damagePerTurn: number;
  movementCost?: number;    // 1-100, default 10
  tileType?: string;
  terrainType?: string;
  bridgeAssetId?: string;
}

interface WeaponDefinition {
  id: string;
  name: string;
  weaponType: 'melee' | 'ranged' | 'throwable';
  frames: number;
  frameDuration: number;
  anchorX: number;
  anchorY: number;
}

interface AnimationInfo {
  row: number;
  frames: number;
  loop: boolean;
}

interface CharacterAtlasInfo {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  animations: Record<string, AnimationInfo>;
  weaponDefId?: string;
  throwableDefId?: string;
}

interface TileAtlasInfo {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  variations: number;
  hasTransitions: boolean;
  tileType?: string;
  terrainType?: string;
  bridgeAssetId?: string;
  passable?: boolean;
  movementCost?: number;
}

interface WeaponAtlasInfo {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  animations: Record<string, AnimationInfo>;
  anchorX: number;
  anchorY: number;
}

interface Manifest {
  version: number;
  spriteSize: number;
  maxFrames: number;
  characters: Record<string, CharacterAtlasInfo>;
  tiles: Record<string, TileAtlasInfo>;
  weapons: Record<string, WeaponAtlasInfo>;
}

// ============================================================================
// Character Atlas Baking (no visual states, just animations)
// ============================================================================

async function bakeCharacterAtlas(id: string, charDir: string): Promise<CharacterAtlasInfo | null> {
  const defPath = path.join(charDir, 'definition.json');
  if (!fs.existsSync(defPath)) {
    console.log(`  Skipping ${id} (no definition.json)`);
    return null;
  }

  const def: CharacterDefinition = JSON.parse(fs.readFileSync(defPath, 'utf-8'));

  // Scan for sprites - only use "full" visual state (primary)
  const files = fs.readdirSync(charDir).filter(f => f.endsWith('.png'));

  // Parse sprite filenames to find animations and frame counts
  // Format: {id}_{visualState}_{animation}_{frame}.png
  // We only take "full" visual state
  const animationFrames: Record<string, number> = {};

  for (const file of files) {
    const basename = file.replace('.png', '');
    const withoutId = basename.startsWith(id + '_') ? basename.slice(id.length + 1) : basename;

    // Only match "full" visual state
    const match = withoutId.match(/^full_(\w+)_(\d+)$/);
    if (match) {
      const [, animationPart, frameStr] = match;
      const frame = parseInt(frameStr, 10);

      // Cap at MAX_FRAMES
      if (frame < MAX_FRAMES) {
        const currentMax = animationFrames[animationPart] || 0;
        animationFrames[animationPart] = Math.max(currentMax, frame + 1);
      }
    }
  }

  if (Object.keys(animationFrames).length === 0) {
    console.log(`  Skipping ${id} (no valid sprites found)`);
    return null;
  }

  // Build animation info
  const animations: Record<string, AnimationInfo> = {};
  const animationOrder = Object.keys(animationFrames).sort();

  let row = 0;
  for (const anim of animationOrder) {
    animations[anim] = {
      row,
      frames: Math.min(animationFrames[anim], MAX_FRAMES),
      loop: !anim.includes('attack'),
    };
    row++;
  }

  const atlasWidth = MAX_FRAMES * spriteSize;
  const atlasHeight = animationOrder.length * spriteSize;

  // Create atlas image
  const atlasBuffer = await createEmptyImage(atlasWidth, atlasHeight);
  const composites: { input: Buffer; left: number; top: number }[] = [];

  // Only use "full" visual state
  for (const [anim, info] of Object.entries(animations)) {
    for (let frame = 0; frame < info.frames; frame++) {
      const spriteName = `${id}_full_${anim}_${frame}.png`;
      const spritePath = path.join(charDir, spriteName);

      if (fs.existsSync(spritePath)) {
        const spriteBuffer = await sharp(spritePath)
          .resize(spriteSize, spriteSize, { kernel: sharp.kernel.nearest })
          .png()
          .toBuffer();

        composites.push({
          input: spriteBuffer,
          left: frame * spriteSize,
          top: info.row * spriteSize,
        });
      }
    }
  }

  // Save atlas
  const atlasPath = path.join(outputDir, 'characters', `${id}.png`);
  fs.mkdirSync(path.dirname(atlasPath), { recursive: true });

  await sharp(atlasBuffer)
    .composite(composites)
    .png()
    .toFile(atlasPath);

  console.log(`  ${id}: ${atlasWidth}x${atlasHeight} (${Object.keys(animations).length} anims)`);

  return {
    id,
    name: def.name,
    atlas: `characters/${id}.png`,
    atlasWidth,
    atlasHeight,
    spriteSize,
    animations,
    ...(def.weaponDefId ? { weaponDefId: def.weaponDefId } : {}),
    ...(def.throwableDefId ? { throwableDefId: def.throwableDefId } : {}),
  };
}

// ============================================================================
// Tile Atlas Baking
// ============================================================================

const TILE_TRANSITIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

async function bakeTileAtlas(id: string, tileDir: string): Promise<TileAtlasInfo | null> {
  // Prefer properties.json (saved by TileEditor with passable + movementCost),
  // fall back to definition.json (legacy import format with walkable only).
  const propsPath = path.join(tileDir, 'properties.json');
  const defPath = path.join(tileDir, 'definition.json');
  const filePath = fs.existsSync(propsPath) ? propsPath : defPath;
  if (!fs.existsSync(filePath)) {
    console.log(`  Skipping ${id} (no definition.json or properties.json)`);
    return null;
  }

  const def: TileDefinition = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Scan for tile sprites
  const files = fs.readdirSync(tileDir).filter(f => f.endsWith('.png'));

  // Find variations: tile_0.png, tile_1.png, etc.
  const basePattern = /^tile_(\d+)\.png$/;
  const transitionPattern = /^tile_(\d+)_transition_(\w+)\.png$/;

  let maxVariation = -1;
  let hasTransitions = false;

  for (const file of files) {
    const baseMatch = file.match(basePattern);
    if (baseMatch) {
      maxVariation = Math.max(maxVariation, parseInt(baseMatch[1], 10));
    }
    if (transitionPattern.test(file)) {
      hasTransitions = true;
    }
  }

  const variations = maxVariation + 1;
  if (variations <= 0) {
    console.log(`  Skipping ${id} (no tile variations found)`);
    return null;
  }

  // Atlas layout:
  // Row 0: base tiles (tile_0, tile_1, ...)
  // Row 1-8: transitions if they exist
  const rows = hasTransitions ? 1 + TILE_TRANSITIONS.length : 1;
  const atlasWidth = variations * spriteSize;
  const atlasHeight = rows * spriteSize;

  const atlasBuffer = await createEmptyImage(atlasWidth, atlasHeight);
  const composites: { input: Buffer; left: number; top: number }[] = [];

  // Base tiles
  for (let v = 0; v < variations; v++) {
    const spritePath = path.join(tileDir, `tile_${v}.png`);
    if (fs.existsSync(spritePath)) {
      const spriteBuffer = await sharp(spritePath)
        .resize(spriteSize, spriteSize, { kernel: sharp.kernel.nearest })
        .png()
        .toBuffer();

      composites.push({
        input: spriteBuffer,
        left: v * spriteSize,
        top: 0,
      });
    }
  }

  // Transitions
  if (hasTransitions) {
    for (let tIdx = 0; tIdx < TILE_TRANSITIONS.length; tIdx++) {
      const trans = TILE_TRANSITIONS[tIdx];
      for (let v = 0; v < variations; v++) {
        const spritePath = path.join(tileDir, `tile_${v}_transition_${trans}.png`);
        if (fs.existsSync(spritePath)) {
          const spriteBuffer = await sharp(spritePath)
            .resize(spriteSize, spriteSize, { kernel: sharp.kernel.nearest })
            .png()
            .toBuffer();

          composites.push({
            input: spriteBuffer,
            left: v * spriteSize,
            top: (1 + tIdx) * spriteSize,
          });
        }
      }
    }
  }

  // Save atlas
  const atlasPath = path.join(outputDir, 'tiles', `${id}.png`);
  fs.mkdirSync(path.dirname(atlasPath), { recursive: true });

  await sharp(atlasBuffer)
    .composite(composites)
    .png()
    .toFile(atlasPath);

  console.log(`  ${id}: ${atlasWidth}x${atlasHeight} (${variations} vars${hasTransitions ? ' + transitions' : ''})`);

  return {
    id,
    name: def.name,
    atlas: `tiles/${id}.png`,
    atlasWidth,
    atlasHeight,
    spriteSize,
    variations,
    hasTransitions,
    tileType: def.tileType,
    terrainType: def.terrainType,
    bridgeAssetId: def.bridgeAssetId,
    passable: def.passable ?? def.walkable ?? true,
    movementCost: def.movementCost ?? 10,
  };
}

// ============================================================================
// Weapon/Object Atlas Baking (no visual states)
// ============================================================================

async function bakeObjectAtlas(id: string, objectDir: string): Promise<WeaponAtlasInfo | null> {
  const defPath = path.join(objectDir, 'definition.json');
  if (!fs.existsSync(defPath)) {
    console.log(`  Skipping ${id} (no definition.json)`);
    return null;
  }

  const def: WeaponDefinition = JSON.parse(fs.readFileSync(defPath, 'utf-8'));

  // Scan for sprites: {id}_{animation}_{frame}.png
  const files = fs.readdirSync(objectDir).filter(f => f.endsWith('.png'));

  const animationFrames: Record<string, number> = {};
  const prefix = `${id}_`;

  for (const file of files) {
    const basename = file.replace('.png', '');
    if (!basename.startsWith(prefix)) continue;
    const rest = basename.slice(prefix.length); // "idle_0", "landed_0"
    const match = rest.match(/^(\w+)_(\d+)$/);
    if (match) {
      const [, anim, frameStr] = match;
      const frame = parseInt(frameStr, 10);
      if (frame < MAX_FRAMES) {
        animationFrames[anim] = Math.max(animationFrames[anim] || 0, frame + 1);
      }
    }
  }

  if (Object.keys(animationFrames).length === 0) {
    console.log(`  Skipping ${id} (no valid sprites found)`);
    return null;
  }

  const animations: Record<string, AnimationInfo> = {};
  const animationOrder = Object.keys(animationFrames).sort();

  let row = 0;
  for (const anim of animationOrder) {
    animations[anim] = {
      row,
      frames: Math.min(animationFrames[anim], MAX_FRAMES),
      loop: anim === 'idle',
    };
    row++;
  }

  const atlasWidth = MAX_FRAMES * spriteSize;
  const atlasHeight = animationOrder.length * spriteSize;

  const atlasBuffer = await createEmptyImage(atlasWidth, atlasHeight);
  const composites: { input: Buffer; left: number; top: number }[] = [];

  for (const [anim, info] of Object.entries(animations)) {
    for (let frame = 0; frame < info.frames; frame++) {
      const spriteName = `${id}_${anim}_${frame}.png`;
      const spritePath = path.join(objectDir, spriteName);

      if (fs.existsSync(spritePath)) {
        const spriteBuffer = await sharp(spritePath)
          .resize(spriteSize, spriteSize, { kernel: sharp.kernel.nearest })
          .png()
          .toBuffer();

        composites.push({
          input: spriteBuffer,
          left: frame * spriteSize,
          top: info.row * spriteSize,
        });
      }
    }
  }

  const atlasPath = path.join(outputDir, 'objects', `${id}.png`);
  fs.mkdirSync(path.dirname(atlasPath), { recursive: true });

  await sharp(atlasBuffer)
    .composite(composites)
    .png()
    .toFile(atlasPath);

  console.log(`  ${id}: ${atlasWidth}x${atlasHeight} (${Object.keys(animations).length} anims)`);

  return {
    id,
    name: def.name,
    atlas: `objects/${id}.png`,
    atlasWidth,
    atlasHeight,
    spriteSize,
    animations,
    anchorX: def.anchorX || spriteSize / 2,
    anchorY: def.anchorY || spriteSize / 2,
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function createEmptyImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\n=== Atlas Baking Tool ===\n');

  // Ensure output directories exist
  fs.mkdirSync(path.join(outputDir, 'characters'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'tiles'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'weapons'), { recursive: true });

  const manifest: Manifest = {
    version: 2,
    spriteSize,
    maxFrames: MAX_FRAMES,
    characters: {},
    tiles: {},
    weapons: {},
  };

  // Bake characters
  const charsDir = path.join(inputDir, 'characters');
  if (fs.existsSync(charsDir)) {
    console.log('Baking character atlases (full visual state only)...');
    const entries = fs.readdirSync(charsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const info = await bakeCharacterAtlas(entry.name, path.join(charsDir, entry.name));
        if (info) {
          manifest.characters[info.id] = info;
        }
      }
    }
  }

  // Bake tiles
  const tilesDir = path.join(inputDir, 'tiles');
  if (fs.existsSync(tilesDir)) {
    console.log('\nBaking tile atlases...');
    const entries = fs.readdirSync(tilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const info = await bakeTileAtlas(entry.name, path.join(tilesDir, entry.name));
        if (info) {
          manifest.tiles[info.id] = info;
        }
      }
    }
  }

  // Bake objects (projectiles, decorations — formerly "weapons")
  const objectsDir = path.join(inputDir, 'objects');
  if (fs.existsSync(objectsDir)) {
    console.log('\nBaking object atlases...');
    const entries = fs.readdirSync(objectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const info = await bakeObjectAtlas(entry.name, path.join(objectsDir, entry.name));
        if (info) {
          // Stored under "weapons" key in manifest for backward compat with existing consumers
          manifest.weapons[info.id] = info;
        }
      }
    }
  }

  // Write manifest
  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Characters: ${Object.keys(manifest.characters).length} atlases`);
  console.log(`Tiles: ${Object.keys(manifest.tiles).length} atlases`);
  console.log(`Objects: ${Object.keys(manifest.weapons).length} atlases`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error('Baking failed:', err);
  process.exit(1);
});
