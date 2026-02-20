#!/usr/bin/env npx tsx
/**
 * Import hexmanos assets into zap-squad format
 *
 * Usage:
 *   npx tsx tools/import-hexmanos.ts --source ~/hexmanos_uploads --output ui/web/public/mods
 *
 * Converts:
 *   - characters/ -> characters/ (128px -> 32px, state mapping)
 *   - tiles/ -> tiles/ (128px -> 32px)
 *   - objects/ -> weapons/ (128px -> 32px)
 *   - maps/ -> levels/ (convert to LDtk-compatible format)
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

// Parse arguments
const args = process.argv.slice(2);
let sourceDir = '';
let outputDir = '';
let targetSize = 32;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source' && args[i + 1]) {
    sourceDir = args[i + 1];
    i++;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputDir = args[i + 1];
    i++;
  } else if (args[i] === '--size' && args[i + 1]) {
    targetSize = parseInt(args[i + 1], 10);
    i++;
  }
}

if (!sourceDir || !outputDir) {
  console.error('Usage: npx tsx import-hexmanos.ts --source <hexmanos_uploads> --output <mods_dir> [--size 32]');
  process.exit(1);
}

// Ensure absolute paths
sourceDir = path.resolve(sourceDir);
outputDir = path.resolve(outputDir);

console.log(`Importing from: ${sourceDir}`);
console.log(`Output to: ${outputDir}`);
console.log(`Target sprite size: ${targetSize}px`);

// Animation state mapping: hexmanos -> zap-squad
const STATE_MAPPING: Record<string, { animation: string; direction: string } | null> = {
  // Idle states
  idle: { animation: 'idle', direction: 'south' },
  idle_down: { animation: 'idle', direction: 'south' },
  idle_up: { animation: 'idle', direction: 'north' },
  idle_left: { animation: 'idle', direction: 'west' },
  idle_right: { animation: 'idle', direction: 'east' },

  // Walk states
  walk_down: { animation: 'walk', direction: 'south' },
  walk_up: { animation: 'walk', direction: 'north' },
  walk_left: { animation: 'walk', direction: 'west' },
  walk_right: { animation: 'walk', direction: 'east' },

  // Attack states -> melee_attack
  attack_down: { animation: 'melee_attack', direction: 'south' },
  attack_up: { animation: 'melee_attack', direction: 'north' },
  attack_left: { animation: 'melee_attack', direction: 'west' },
  attack_right: { animation: 'melee_attack', direction: 'east' },

  // Action states (non-directional attacks) -> melee_attack south
  action_attack: { animation: 'melee_attack', direction: 'south' },
  action_build: null, // Skip non-combat actions
};

// Visual state mapping (same names, just validate)
const VISUAL_STATES = ['full', 'hurt_1', 'hurt_2', 'critical'];

interface HexmanosCharacterDef {
  name: string;
  spriteSize: number;
  entityType: string;
  visualStates: string[];
  states: Record<string, { frames: number; loop: boolean }>;
  attacks?: Array<{
    id: string;
    name: string;
    type: string;
    range: number;
    damage: number;
    cooldownMs: number;
    projectileSpeed?: number;
    projectileAssetId?: string;
  }>;
}

interface HexmanosTileDef {
  name: string;
  tileSize: number;
  passable: boolean;
  variations: number;
  tileType: string;
  terrainType: string;
  movementCost: number;
  pathWidth?: number;
}

interface HexmanosObjectDef {
  name: string;
  spriteSize: number;
  entityType: string;
  visualStates: string[];
  states: Record<string, { frames: number; loop: boolean }>;
}

interface HexmanosMap {
  name: string;
  width: number;
  height: number;
  tileSize: number;
  layers: {
    terrain: Array<Array<{ tileAssetId: string; seed: number } | null>>;
    waterPaths?: Array<Array<{ pathAssetId: string } | null>>;
    groundPaths?: Array<Array<{ pathAssetId: string } | null>>;
    paths?: Array<Array<{ pathAssetId: string } | null>>; // Legacy field
  };
  characters?: Array<{ characterAssetId: string; x: number; y: number }>;
}

interface ZapSquadCharacterDef {
  id: string;
  name: string;
  frames: number;
  frameDuration: number;
  createdAt: string;
  updatedAt: string;
}

interface ZapSquadTileDef {
  id: string;
  name: string;
  walkable: boolean;
  blocksVision: boolean;
  damagePerTurn: number;
  tileType: string; // TILE, PATH, BRIDGE
  terrainType: string; // LAND, WATER
  bridgeAssetId?: string; // Reference to bridge tile for water crossings
  variations: number;
  createdAt: string;
  updatedAt: string;
}

interface ZapSquadWeaponDef {
  id: string;
  name: string;
  weaponType: 'melee' | 'ranged' | 'throwable';
  frames: number;
  frameDuration: number;
  anchorX: number;
  anchorY: number;
  createdAt: string;
  updatedAt: string;
}

// Resize image using sharp (with nearest-neighbor for pixel art)
async function resizeImage(
  inputPath: string,
  outputPath: string,
  targetWidth: number,
  targetHeight: number
): Promise<void> {
  await sharp(inputPath)
    .resize(targetWidth, targetHeight, {
      kernel: sharp.kernel.nearest, // Preserve pixel art crispness
      fit: 'fill',
    })
    .png()
    .toFile(outputPath);
}

// Import characters
async function importCharacters(): Promise<Map<string, string>> {
  const idMapping = new Map<string, string>();
  const charactersDir = path.join(sourceDir, 'characters');

  if (!fs.existsSync(charactersDir)) {
    console.log('No characters directory found');
    return idMapping;
  }

  const entries = fs.readdirSync(charactersDir, { withFileTypes: true });
  const characterDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  console.log(`\nImporting ${characterDirs.length} characters...`);

  for (const dir of characterDirs) {
    const uuid = dir.name;
    const defPath = path.join(charactersDir, uuid, 'definition.json');

    if (!fs.existsSync(defPath)) {
      console.log(`  Skipping ${uuid} (no definition.json)`);
      continue;
    }

    const def: HexmanosCharacterDef = JSON.parse(fs.readFileSync(defPath, 'utf-8'));

    // Generate a clean ID from name
    const cleanId = def.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    idMapping.set(uuid, cleanId);

    const outDir = path.join(outputDir, 'characters', cleanId);
    fs.mkdirSync(outDir, { recursive: true });

    // Find max frames across all states
    let maxFrames = 4;
    if (def.states) {
      for (const state of Object.values(def.states)) {
        if (state && state.frames > maxFrames) maxFrames = state.frames;
      }
    }

    // Write new definition
    const now = new Date().toISOString();
    const newDef: ZapSquadCharacterDef = {
      id: cleanId,
      name: def.name,
      frames: maxFrames,
      frameDuration: 0.1,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(path.join(outDir, 'definition.json'), JSON.stringify(newDef, null, 2));

    // Import sprites
    let spriteCount = 0;
    if (!def.states) {
      console.log(`  ${uuid} -> ${cleanId} (0 sprites - no states defined)`);
      continue;
    }

    for (const visualState of VISUAL_STATES) {
      for (const [hexState, mapping] of Object.entries(STATE_MAPPING)) {
        if (!mapping) continue;

        const stateConfig = def.states[hexState];
        if (!stateConfig) continue;

        for (let frame = 0; frame < stateConfig.frames; frame++) {
          // Source: {visualState}_{state}_{frame}.png
          const srcName = `${visualState}_${hexState}_${frame}.png`;
          const srcPath = path.join(charactersDir, uuid, srcName);

          if (!fs.existsSync(srcPath)) continue;

          // Dest: {id}_{visualState}_{animation}_{direction}_{frame}.png
          const destName = `${cleanId}_${visualState}_${mapping.animation}_${mapping.direction}_${frame}.png`;
          const destPath = path.join(outDir, destName);

          await resizeImage(srcPath, destPath, targetSize, targetSize);
          spriteCount++;
        }
      }
    }

    console.log(`  ${uuid} -> ${cleanId} (${spriteCount} sprites)`);
  }

  return idMapping;
}

// Import tiles
async function importTiles(): Promise<Map<string, string>> {
  const idMapping = new Map<string, string>();
  const tilesDir = path.join(sourceDir, 'tiles');

  if (!fs.existsSync(tilesDir)) {
    console.log('No tiles directory found');
    return idMapping;
  }

  const entries = fs.readdirSync(tilesDir, { withFileTypes: true });
  const tileDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  console.log(`\nImporting ${tileDirs.length} tiles...`);

  for (const dir of tileDirs) {
    const uuid = dir.name;
    const defPath = path.join(tilesDir, uuid, 'properties.json');

    if (!fs.existsSync(defPath)) {
      console.log(`  Skipping ${uuid} (no properties.json)`);
      continue;
    }

    const def: HexmanosTileDef = JSON.parse(fs.readFileSync(defPath, 'utf-8'));

    // Generate clean ID
    const cleanId = def.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    idMapping.set(uuid, cleanId);

    const outDir = path.join(outputDir, 'tiles', cleanId);
    fs.mkdirSync(outDir, { recursive: true });

    // Write new definition (bridgeAssetId will be resolved in second pass)
    const now = new Date().toISOString();
    const newDef: ZapSquadTileDef = {
      id: cleanId,
      name: def.name,
      walkable: def.passable,
      blocksVision: false,
      damagePerTurn: 0,
      tileType: def.tileType || 'TILE',
      terrainType: def.terrainType || 'LAND',
      bridgeAssetId: def.bridgeAssetId, // Store raw UUID for now
      variations: def.variations || 1,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(path.join(outDir, 'definition.json'), JSON.stringify(newDef, null, 2));

    // Import tile sprites (variations and transitions)
    const files = fs.readdirSync(path.join(tilesDir, uuid));
    let spriteCount = 0;

    for (const file of files) {
      if (!file.endsWith('.png') || file.includes('-mip')) continue;

      const srcPath = path.join(tilesDir, uuid, file);
      const destPath = path.join(outDir, file);

      await resizeImage(srcPath, destPath, targetSize, targetSize);
      spriteCount++;
    }

    console.log(`  ${uuid} -> ${cleanId} (${spriteCount} sprites)`);
  }

  // Second pass: resolve bridgeAssetId UUIDs to clean tile IDs
  console.log('\nResolving bridge references...');
  for (const [uuid, cleanId] of idMapping) {
    const defPath = path.join(outputDir, 'tiles', cleanId, 'definition.json');
    if (fs.existsSync(defPath)) {
      const def = JSON.parse(fs.readFileSync(defPath, 'utf-8'));
      if (def.bridgeAssetId && idMapping.has(def.bridgeAssetId)) {
        def.bridgeAssetId = idMapping.get(def.bridgeAssetId);
        fs.writeFileSync(defPath, JSON.stringify(def, null, 2));
        console.log(`  ${cleanId} -> bridge: ${def.bridgeAssetId}`);
      } else if (def.bridgeAssetId) {
        // Remove invalid bridge reference
        delete def.bridgeAssetId;
        fs.writeFileSync(defPath, JSON.stringify(def, null, 2));
      }
    }
  }

  return idMapping;
}

// Import objects (keep as objects, not weapons)
async function importObjects(): Promise<Map<string, string>> {
  const idMapping = new Map<string, string>();
  const objectsDir = path.join(sourceDir, 'objects');

  if (!fs.existsSync(objectsDir)) {
    console.log('No objects directory found');
    return idMapping;
  }

  const entries = fs.readdirSync(objectsDir, { withFileTypes: true });
  const objectDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  console.log(`\nImporting ${objectDirs.length} objects...`);

  for (const dir of objectDirs) {
    const uuid = dir.name;
    const defPath = path.join(objectsDir, uuid, 'definition.json');

    if (!fs.existsSync(defPath)) {
      console.log(`  Skipping ${uuid} (no definition.json)`);
      continue;
    }

    const def: HexmanosObjectDef = JSON.parse(fs.readFileSync(defPath, 'utf-8'));

    // Generate clean ID
    const cleanId = def.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    idMapping.set(uuid, cleanId);

    // Import to OBJECTS folder (not weapons)
    const outDir = path.join(outputDir, 'objects', cleanId);
    fs.mkdirSync(outDir, { recursive: true });

    // Find max frames
    let maxFrames = 1;
    if (def.states) {
      for (const state of Object.values(def.states)) {
        if (state && state.frames > maxFrames) maxFrames = state.frames;
      }
    }

    // Write new definition (object format - idle/landed animations only)
    const now = new Date().toISOString();
    const newDef = {
      id: cleanId,
      name: def.name,
      entityType: def.entityType || 'OBJECT',
      frames: maxFrames,
      frameDuration: 0.1,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(path.join(outDir, 'definition.json'), JSON.stringify(newDef, null, 2));

    // Import sprites - convert to object naming convention
    const files = fs.readdirSync(path.join(objectsDir, uuid));
    let spriteCount = 0;

    for (const file of files) {
      if (!file.endsWith('.png') || file.includes('-mip')) continue;

      const srcPath = path.join(objectsDir, uuid, file);

      // Convert naming: full_idle_0.png -> {cleanId}_idle_0.png
      // or just copy as-is and rename to match object convention
      let destName = file;

      // If file has visual state prefix (full_, critical_, etc), strip it for objects
      const visualStates = ['full_', 'hurt_1_', 'hurt_2_', 'critical_'];
      for (const vs of visualStates) {
        if (file.startsWith(vs)) {
          destName = `${cleanId}_${file.substring(vs.length)}`;
          break;
        }
      }

      // If no visual state prefix, just prepend cleanId
      if (destName === file && !file.startsWith(cleanId)) {
        destName = `${cleanId}_${file}`;
      }

      const destPath = path.join(outDir, destName);
      await resizeImage(srcPath, destPath, targetSize, targetSize);
      spriteCount++;
    }

    console.log(`  ${uuid} -> ${cleanId} (${spriteCount} sprites)`);
  }

  return idMapping;
}

// Import maps as LDtk-compatible levels
async function importMaps(
  tileMapping: Map<string, string>,
  characterMapping: Map<string, string>
): Promise<void> {
  const mapsDir = path.join(sourceDir, 'maps');

  if (!fs.existsSync(mapsDir)) {
    console.log('No maps directory found');
    return;
  }

  const entries = fs.readdirSync(mapsDir, { withFileTypes: true });
  const mapDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  console.log(`\nImporting ${mapDirs.length} maps...`);

  const outDir = path.join(outputDir, 'levels');
  fs.mkdirSync(outDir, { recursive: true });

  for (const dir of mapDirs) {
    const uuid = dir.name;
    const mapPath = path.join(mapsDir, uuid, 'map.json');

    if (!fs.existsSync(mapPath)) {
      console.log(`  Skipping ${uuid} (no map.json)`);
      continue;
    }

    const map: HexmanosMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));

    // Generate clean ID
    const cleanId = map.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    // Convert to LDtk-compatible format
    const ldtkLevel = {
      identifier: cleanId,
      pxWid: map.width * targetSize,
      pxHei: map.height * targetSize,
      layerInstances: [
        {
          __identifier: 'Tiles',
          __type: 'Tiles',
          __gridSize: targetSize,
          gridTiles: [] as Array<{ px: number[]; t: number; src: string }>,
        },
        {
          __identifier: 'Entities',
          __type: 'Entities',
          __gridSize: targetSize,
          entityInstances: [] as Array<{
            __identifier: string;
            px: number[];
            fieldInstances: Array<{ __identifier: string; __value: unknown }>;
          }>,
        },
      ],
    };

    // Convert terrain layer
    const tilesLayer = ldtkLevel.layerInstances[0];
    for (let y = 0; y < map.height && y < map.layers.terrain.length; y++) {
      const row = map.layers.terrain[y];
      if (!row) continue;

      for (let x = 0; x < map.width && x < row.length; x++) {
        const cell = row[x];
        if (!cell) continue;

        const tileId = tileMapping.get(cell.tileAssetId) || cell.tileAssetId;
        tilesLayer.gridTiles.push({
          px: [x * targetSize, y * targetSize],
          t: cell.seed % 100, // Use seed as variation index
          src: tileId,
        });
      }
    }

    // Convert water paths (rivers, moats, lava)
    const waterPaths = map.layers.waterPaths || map.layers.paths;
    if (waterPaths) {
      for (let y = 0; y < map.height && y < waterPaths.length; y++) {
        const row = waterPaths[y];
        if (!row) continue;

        for (let x = 0; x < map.width && x < row.length; x++) {
          const cell = row[x];
          if (!cell) continue;

          const tileId = tileMapping.get(cell.pathAssetId) || cell.pathAssetId;
          tilesLayer.gridTiles.push({
            px: [x * targetSize, y * targetSize],
            t: Math.floor(Math.random() * 100), // Random seed for paths
            src: tileId,
          });
        }
      }
    }

    // Convert ground paths (roads, bridges)
    const groundPaths = map.layers.groundPaths;
    if (groundPaths) {
      for (let y = 0; y < map.height && y < groundPaths.length; y++) {
        const row = groundPaths[y];
        if (!row) continue;

        for (let x = 0; x < map.width && x < row.length; x++) {
          const cell = row[x];
          if (!cell) continue;

          const tileId = tileMapping.get(cell.pathAssetId) || cell.pathAssetId;
          tilesLayer.gridTiles.push({
            px: [x * targetSize, y * targetSize],
            t: Math.floor(Math.random() * 100), // Random seed for paths
            src: tileId,
          });
        }
      }
    }

    // Convert characters
    const entitiesLayer = ldtkLevel.layerInstances[1];
    if (map.characters) {
      for (const char of map.characters) {
        const charId = characterMapping.get(char.characterAssetId) || char.characterAssetId;
        entitiesLayer.entityInstances.push({
          __identifier: 'Character',
          px: [char.x * targetSize + targetSize / 2, char.y * targetSize + targetSize / 2],
          fieldInstances: [
            { __identifier: 'body_def_id', __value: charId },
            { __identifier: 'tag', __value: 'enemy' },
          ],
        });
      }
    }

    // Write level file
    const levelFile = { levels: [ldtkLevel] };
    fs.writeFileSync(
      path.join(outDir, `${cleanId}.json`),
      JSON.stringify(levelFile, null, 2)
    );

    console.log(
      `  ${uuid} -> ${cleanId}.json (${tilesLayer.gridTiles.length} tiles, ${entitiesLayer.entityInstances.length} entities)`
    );
  }
}

// Main
async function main() {
  console.log('\n=== Hexmanos to Zap-Squad Asset Importer ===\n');

  // Ensure output directories exist
  fs.mkdirSync(path.join(outputDir, 'characters'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'tiles'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'weapons'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'levels'), { recursive: true });

  const characterMapping = await importCharacters();
  const tileMapping = await importTiles();
  const objectMapping = await importObjects();
  await importMaps(tileMapping, characterMapping);

  // Write ID mapping for reference
  const mapping = {
    characters: Object.fromEntries(characterMapping),
    tiles: Object.fromEntries(tileMapping),
    objects: Object.fromEntries(objectMapping),
  };
  fs.writeFileSync(
    path.join(outputDir, 'hexmanos-mapping.json'),
    JSON.stringify(mapping, null, 2)
  );

  console.log('\n=== Import Complete ===');
  console.log(`Characters: ${characterMapping.size}`);
  console.log(`Tiles: ${tileMapping.size}`);
  console.log(`Objects/Weapons: ${objectMapping.size}`);
  console.log(`\nID mapping saved to: ${path.join(outputDir, 'hexmanos-mapping.json')}`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
