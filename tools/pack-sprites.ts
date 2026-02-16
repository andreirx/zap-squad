#!/usr/bin/env npx tsx
/**
 * Sprite Packer for zap-architect
 *
 * Takes individual PNG files from the mods folder structure and packs them
 * into grid-based sprite sheets compatible with zap-engine and LDtk.
 *
 * Input structure:
 *   public/mods/
 *     characters/{id}/*.png (64 files per character: 4 visual × 4 anim × 4 dir × 4 frames)
 *     weapons/{id}/*.png (64 files per weapon: 4 anim × 4 dir × 4 frames)
 *     tiles/{id}/sprite.png (1 file per tile)
 *
 * Output:
 *   public/assets/
 *     characters_{id}_16x4.png (16 cols × 4 rows grid)
 *     weapons_{id}_16x4.png
 *     tiles_16x16.png (all tiles packed into one atlas)
 *     assets.json (zap-engine manifest)
 *     tilesets.json (LDtk tileset definitions)
 *
 * Usage:
 *   npx tsx tools/pack-sprites.ts [--input public/mods] [--output public/assets]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCanvas, loadImage, type Canvas } from 'canvas';

// ============================================================================
// Types
// ============================================================================

interface PackedAtlas {
  name: string;
  filename: string;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  canvas: Canvas;
  sprites: Map<string, { col: number; row: number }>;
}

interface ZapManifest {
  atlases: {
    name: string;
    cols: number;
    rows: number;
    path: string;
  }[];
  sprites: Record<string, { atlas: number; col: number; row: number }>;
  sounds: Record<string, unknown>;
}

interface LdtkTileset {
  identifier: string;
  uid: number;
  relPath: string;
  pxWid: number;
  pxHei: number;
  tileGridSize: number;
  spacing: number;
  padding: number;
  tags: string[];
  enumTags: unknown[];
}

// ============================================================================
// Constants
// ============================================================================

const SPRITE_SIZE = 32; // Default sprite size
const TILE_SIZE = 16;   // Default tile size

// Character sprite layout: visual_state × animation_state × direction × frame
// 4 visual states × 4 animation states = 16 rows
// 4 directions × 4 frames = 16 columns
const CHAR_COLS = 16;
const CHAR_ROWS = 4; // Actually we organize differently - see below

// Visual states in order
const VISUAL_STATES = ['full', 'hurt_1', 'hurt_2', 'critical'] as const;

// Animation states in order
const ANIMATION_STATES = ['idle', 'walk', 'melee_attack', 'throw_attack'] as const;

// Directions in order
const DIRECTIONS = ['north', 'east', 'south', 'west'] as const;

// Frames per animation
const FRAMES_PER_ANIM = 4;

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function listFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .sort();
}

// ============================================================================
// Character Packing
// ============================================================================

/**
 * Pack a single character into a sprite sheet.
 *
 * Layout (16 cols × 16 rows):
 *   Rows 0-3:   full health (idle, walk, melee, throw) × 4 frames per direction
 *   Rows 4-7:   hurt_1
 *   Rows 8-11:  hurt_2
 *   Rows 12-15: critical
 *
 *   Each row: [N0 N1 N2 N3] [E0 E1 E2 E3] [S0 S1 S2 S3] [W0 W1 W2 W3]
 */
async function packCharacter(
  charDir: string,
  charId: string,
  outputDir: string,
): Promise<PackedAtlas | null> {
  const sprites = new Map<string, { col: number; row: number }>();
  const cols = 16; // 4 directions × 4 frames
  const rows = 16; // 4 visual × 4 animation

  const canvas = createCanvas(cols * SPRITE_SIZE, rows * SPRITE_SIZE);
  const ctx = canvas.getContext('2d');

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

          // Expected filename: {charId}_{visual}_{anim}_{dir}_{frame}.png
          const filename = `${charId}_${visual}_${anim}_${dir}_${frame}.png`;
          const filepath = path.join(charDir, filename);

          if (fs.existsSync(filepath)) {
            try {
              const img = await loadImage(filepath);
              ctx.drawImage(img, col * SPRITE_SIZE, row * SPRITE_SIZE, SPRITE_SIZE, SPRITE_SIZE);
              hasAnySprite = true;
            } catch (e) {
              console.warn(`  Warning: Failed to load ${filename}: ${e}`);
            }
          }

          // Register sprite name even if file doesn't exist (for consistent manifest)
          const spriteName = `${charId}_${visual}_${anim}_${dir}_${frame}`;
          sprites.set(spriteName, { col, row });
        }
      }
    }
  }

  if (!hasAnySprite) {
    return null;
  }

  const filename = `characters_${charId}_${cols}x${rows}.png`;
  return {
    name: `characters_${charId}`,
    filename,
    cols,
    rows,
    cellWidth: SPRITE_SIZE,
    cellHeight: SPRITE_SIZE,
    canvas,
    sprites,
  };
}

// ============================================================================
// Weapon Packing
// ============================================================================

/**
 * Pack a single weapon into a sprite sheet.
 *
 * Layout (16 cols × 4 rows):
 *   Rows: idle, walk, melee_attack, throw_attack
 *   Cols: [N0 N1 N2 N3] [E0 E1 E2 E3] [S0 S1 S2 S3] [W0 W1 W2 W3]
 */
async function packWeapon(
  weaponDir: string,
  weaponId: string,
  outputDir: string,
): Promise<PackedAtlas | null> {
  const sprites = new Map<string, { col: number; row: number }>();
  const cols = 16;
  const rows = 4;

  const canvas = createCanvas(cols * SPRITE_SIZE, rows * SPRITE_SIZE);
  const ctx = canvas.getContext('2d');

  let hasAnySprite = false;

  for (let ai = 0; ai < ANIMATION_STATES.length; ai++) {
    const anim = ANIMATION_STATES[ai];
    const row = ai;

    for (let di = 0; di < DIRECTIONS.length; di++) {
      const dir = DIRECTIONS[di];

      for (let frame = 0; frame < FRAMES_PER_ANIM; frame++) {
        const col = di * 4 + frame;

        // Expected filename: {weaponId}_{anim}_{dir}_{frame}.png
        const filename = `${weaponId}_${anim}_${dir}_${frame}.png`;
        const filepath = path.join(weaponDir, filename);

        if (fs.existsSync(filepath)) {
          try {
            const img = await loadImage(filepath);
            ctx.drawImage(img, col * SPRITE_SIZE, row * SPRITE_SIZE, SPRITE_SIZE, SPRITE_SIZE);
            hasAnySprite = true;
          } catch (e) {
            console.warn(`  Warning: Failed to load ${filename}: ${e}`);
          }
        }

        const spriteName = `${weaponId}_${anim}_${dir}_${frame}`;
        sprites.set(spriteName, { col, row });
      }
    }
  }

  if (!hasAnySprite) {
    return null;
  }

  const filename = `weapons_${weaponId}_${cols}x${rows}.png`;
  return {
    name: `weapons_${weaponId}`,
    filename,
    cols,
    rows,
    cellWidth: SPRITE_SIZE,
    cellHeight: SPRITE_SIZE,
    canvas,
    sprites,
  };
}

// ============================================================================
// Tile Packing
// ============================================================================

/**
 * Pack all tiles into a single sprite sheet.
 *
 * Auto-calculates grid size based on tile count.
 * Packs in row-major order.
 */
async function packTiles(
  tilesDir: string,
  outputDir: string,
): Promise<PackedAtlas | null> {
  const tileIds = listDirs(tilesDir);
  if (tileIds.length === 0) return null;

  // Calculate grid dimensions (aim for roughly square)
  const count = tileIds.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const sprites = new Map<string, { col: number; row: number }>();
  const canvas = createCanvas(cols * TILE_SIZE, rows * TILE_SIZE);
  const ctx = canvas.getContext('2d');

  let hasAnySprite = false;
  let index = 0;

  for (const tileId of tileIds.sort()) {
    const filepath = path.join(tilesDir, tileId, 'sprite.png');
    const col = index % cols;
    const row = Math.floor(index / cols);

    if (fs.existsSync(filepath)) {
      try {
        const img = await loadImage(filepath);
        ctx.drawImage(img, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        hasAnySprite = true;
      } catch (e) {
        console.warn(`  Warning: Failed to load tile ${tileId}: ${e}`);
      }
    }

    sprites.set(`tile_${tileId}`, { col, row });
    index++;
  }

  if (!hasAnySprite) {
    return null;
  }

  const filename = `tiles_${cols}x${rows}.png`;
  return {
    name: 'tiles',
    filename,
    cols,
    rows,
    cellWidth: TILE_SIZE,
    cellHeight: TILE_SIZE,
    canvas,
    sprites,
  };
}

// ============================================================================
// Manifest Generation
// ============================================================================

function generateManifest(atlases: PackedAtlas[]): ZapManifest {
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
// LDtk Tileset Generation
// ============================================================================

function generateLdtkTilesets(atlases: PackedAtlas[]): LdtkTileset[] {
  const tilesets: LdtkTileset[] = [];
  let uid = 1;

  for (const atlas of atlases) {
    // Only tiles atlas is useful as LDtk tileset
    if (atlas.name === 'tiles') {
      tilesets.push({
        identifier: 'Tiles',
        uid: uid++,
        relPath: `../assets/${atlas.filename}`,
        pxWid: atlas.cols * atlas.cellWidth,
        pxHei: atlas.rows * atlas.cellHeight,
        tileGridSize: atlas.cellWidth,
        spacing: 0,
        padding: 0,
        tags: [],
        enumTags: [],
      });
    }
  }

  return tilesets;
}

// ============================================================================
// Tile ID Mapping (for LDtk IntGrid)
// ============================================================================

interface TileMapping {
  tileIdToName: Record<number, string>;
  nameToTileId: Record<string, number>;
}

function generateTileMapping(tilesAtlas: PackedAtlas | null): TileMapping {
  const mapping: TileMapping = {
    tileIdToName: {},
    nameToTileId: {},
  };

  if (!tilesAtlas) return mapping;

  let id = 1; // 0 is reserved for "empty/walkable"
  for (const [spriteName, pos] of tilesAtlas.sprites) {
    // LDtk uses linear index: row * cols + col
    const ldtkId = pos.row * tilesAtlas.cols + pos.col;
    mapping.tileIdToName[ldtkId] = spriteName;
    mapping.nameToTileId[spriteName] = ldtkId;
    id++;
  }

  return mapping;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  let inputDir = 'public/mods';
  let outputDir = 'public/assets';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputDir = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[++i];
    }
  }

  console.log(`Packing sprites from ${inputDir} → ${outputDir}`);

  ensureDir(outputDir);

  const allAtlases: PackedAtlas[] = [];

  // Pack characters
  const charactersDir = path.join(inputDir, 'characters');
  const characterIds = listDirs(charactersDir);
  console.log(`\nFound ${characterIds.length} characters`);

  for (const charId of characterIds) {
    const charDir = path.join(charactersDir, charId);
    console.log(`  Packing character: ${charId}`);
    const atlas = await packCharacter(charDir, charId, outputDir);
    if (atlas) {
      allAtlases.push(atlas);
    }
  }

  // Pack weapons
  const weaponsDir = path.join(inputDir, 'weapons');
  const weaponIds = listDirs(weaponsDir);
  console.log(`\nFound ${weaponIds.length} weapons`);

  for (const weaponId of weaponIds) {
    const weaponDir = path.join(weaponsDir, weaponId);
    console.log(`  Packing weapon: ${weaponId}`);
    const atlas = await packWeapon(weaponDir, weaponId, outputDir);
    if (atlas) {
      allAtlases.push(atlas);
    }
  }

  // Pack tiles
  const tilesDir = path.join(inputDir, 'tiles');
  console.log(`\nPacking tiles`);
  const tilesAtlas = await packTiles(tilesDir, outputDir);
  if (tilesAtlas) {
    allAtlases.push(tilesAtlas);
  }

  // Save atlas images
  console.log(`\nWriting ${allAtlases.length} atlas images...`);
  for (const atlas of allAtlases) {
    const outPath = path.join(outputDir, atlas.filename);
    const buffer = atlas.canvas.toBuffer('image/png');
    fs.writeFileSync(outPath, buffer);
    console.log(`  ${atlas.filename} (${atlas.cols}×${atlas.rows} = ${atlas.sprites.size} sprites)`);
  }

  // Generate and save manifest
  const manifest = generateManifest(allAtlases);
  const manifestPath = path.join(outputDir, 'assets.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nGenerated ${manifestPath}`);
  console.log(`  ${manifest.atlases.length} atlases, ${Object.keys(manifest.sprites).length} sprites`);

  // Generate LDtk tilesets
  const tilesets = generateLdtkTilesets(allAtlases);
  if (tilesets.length > 0) {
    const tilesetsPath = path.join(outputDir, 'ldtk-tilesets.json');
    fs.writeFileSync(tilesetsPath, JSON.stringify(tilesets, null, 2));
    console.log(`\nGenerated ${tilesetsPath} (${tilesets.length} tilesets for LDtk)`);
  }

  // Generate tile mapping
  const tileMapping = generateTileMapping(tilesAtlas);
  if (Object.keys(tileMapping.nameToTileId).length > 0) {
    const mappingPath = path.join(outputDir, 'tile-mapping.json');
    fs.writeFileSync(mappingPath, JSON.stringify(tileMapping, null, 2));
    console.log(`Generated ${mappingPath}`);
  }

  console.log('\nDone!');
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
