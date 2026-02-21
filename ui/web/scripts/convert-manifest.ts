/**
 * Convert zap-squad manifest.json to zap-engine assets.json format
 *
 * Run: npx tsx scripts/convert-manifest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Input/output paths
const inputPath = path.join(__dirname, '../public/assets/manifest.json');
const outputPath = path.join(__dirname, '../public/assets/assets.json');

// Type definitions matching manifest.json structure
interface Animation {
  row: number;
  frames: number;
  loop: boolean;
}

interface CharacterDef {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  animations: Record<string, Animation>;
}

interface TileDef {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  variations: number;
  hasTransitions: boolean;
}

interface WeaponDef {
  id: string;
  name: string;
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  animations: Record<string, Animation>;
  anchorX: number;
  anchorY: number;
}

interface Manifest {
  version: number;
  spriteSize: number;
  maxFrames: number;
  characters: Record<string, CharacterDef>;
  tiles: Record<string, TileDef>;
  weapons: Record<string, WeaponDef>;
}

// zap-engine assets.json format
interface Atlas {
  name: string;
  cols: number;
  rows: number;
  path: string;
}

interface SpriteRef {
  atlas: number;
  col: number;
  row: number;
}

interface Assets {
  atlases: Atlas[];
  sprites: Record<string, SpriteRef>;
}

// Direction mapping: editor uses north/south/east/west
const directionMap: Record<string, string> = {
  north: 'north',
  south: 'south',
  east: 'east',
  west: 'west',
};

// Read manifest
const manifest: Manifest = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

const assets: Assets = {
  atlases: [],
  sprites: {},
};

let atlasIndex = 0;

// Process characters
for (const [id, char] of Object.entries(manifest.characters || {})) {
  const cols = Math.floor(char.atlasWidth / char.spriteSize);
  const rows = Math.floor(char.atlasHeight / char.spriteSize);

  assets.atlases.push({
    name: `characters_${id}`,
    cols,
    rows,
    path: char.atlas,
  });

  // Add sprite entries for each animation
  for (const [animName, anim] of Object.entries(char.animations || {})) {
    // Base animation sprite (without frame number)
    assets.sprites[`${id}/${animName}`] = {
      atlas: atlasIndex,
      col: 0,
      row: anim.row,
    };

    // Individual frames
    for (let frame = 0; frame < anim.frames; frame++) {
      assets.sprites[`${id}/${animName}/${frame}`] = {
        atlas: atlasIndex,
        col: frame,
        row: anim.row,
      };
    }
  }
  atlasIndex++;
}

// Process tiles
for (const [id, tile] of Object.entries(manifest.tiles || {})) {
  const cols = Math.floor(tile.atlasWidth / tile.spriteSize);
  const rows = Math.floor(tile.atlasHeight / tile.spriteSize);

  assets.atlases.push({
    name: `tiles_${id}`,
    cols,
    rows,
    path: tile.atlas,
  });

  // Base sprite name (fallback)
  assets.sprites[id] = {
    atlas: atlasIndex,
    col: 0,
    row: 0,
  };

  // All cells in the atlas grid: {id}_{index}
  // Index = row * cols + col
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      assets.sprites[`${id}_${idx}`] = {
        atlas: atlasIndex,
        col,
        row,
      };
    }
  }

  atlasIndex++;
}

// Process weapons
for (const [id, weapon] of Object.entries(manifest.weapons || {})) {
  const cols = Math.floor(weapon.atlasWidth / weapon.spriteSize);
  const rows = Math.floor(weapon.atlasHeight / weapon.spriteSize);

  assets.atlases.push({
    name: `weapons_${id}`,
    cols,
    rows,
    path: weapon.atlas,
  });

  // Add sprite entries for each animation
  for (const [animName, anim] of Object.entries(weapon.animations || {})) {
    // Base animation sprite
    assets.sprites[`${id}/${animName}`] = {
      atlas: atlasIndex,
      col: 0,
      row: anim.row,
    };

    // Individual frames
    for (let frame = 0; frame < anim.frames; frame++) {
      assets.sprites[`${id}/${animName}/${frame}`] = {
        atlas: atlasIndex,
        col: frame,
        row: anim.row,
      };
    }
  }
  atlasIndex++;
}

// Write output
fs.writeFileSync(outputPath, JSON.stringify(assets, null, 2));
console.log(`Created ${outputPath}`);
console.log(`  - ${assets.atlases.length} atlases`);
console.log(`  - ${Object.keys(assets.sprites).length} sprites`);
