/**
 * Atlas Schema Types
 *
 * Single source of truth for sprite sheet layouts.
 * Used by editors (to edit specific cells) and renderer (to extract sprites).
 */

// ============================================================================
// Constants
// ============================================================================

export const MAX_FRAMES = 8;
export const SPRITE_SIZE = 128;

// Character animations in alphabetical order (matches bake-atlases.ts)
export const CHARACTER_ANIMATIONS = [
  'idle_east',
  'idle_north',
  'idle_south',
  'idle_west',
  'melee_attack_east',
  'melee_attack_north',
  'melee_attack_south',
  'melee_attack_west',
  'walk_east',
  'walk_north',
  'walk_south',
  'walk_west',
] as const;

export type CharacterAnimation = typeof CHARACTER_ANIMATIONS[number];

// Directions
export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const;
export type Direction = typeof DIRECTIONS[number];

// Animation types
export const ANIMATION_TYPES = ['idle', 'walk', 'melee_attack'] as const;
export type AnimationType = typeof ANIMATION_TYPES[number];

// Tile transitions in order (matches bake-atlases.ts)
export const TILE_TRANSITIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type TileTransition = typeof TILE_TRANSITIONS[number];

// Weapon animations
export const WEAPON_ANIMATIONS = ['idle', 'landed'] as const;
export type WeaponAnimation = typeof WEAPON_ANIMATIONS[number];

// ============================================================================
// Atlas Layout Schemas
// ============================================================================

/**
 * Character Atlas Layout
 *
 * Columns: 8 (frames 0-7)
 * Rows: one per animation (sorted alphabetically)
 *
 * Example for a character with all animations:
 *   Row 0: idle_east (1 frame)
 *   Row 1: idle_north (1 frame)
 *   Row 2: idle_south (1 frame)
 *   Row 3: idle_west (1 frame)
 *   Row 4: melee_attack_east (7 frames)
 *   Row 5: melee_attack_north (7 frames)
 *   Row 6: melee_attack_south (7 frames)
 *   Row 7: melee_attack_west (7 frames)
 *   Row 8: walk_east (4 frames)
 *   Row 9: walk_north (4 frames)
 *   Row 10: walk_south (4 frames)
 *   Row 11: walk_west (4 frames)
 */
export interface CharacterAtlasSchema {
  type: 'character';
  id: string;
  name: string;
  spriteSize: number;
  columns: number; // Always MAX_FRAMES (8)
  rows: CharacterAnimationRow[];
}

export interface CharacterAnimationRow {
  animation: string;
  row: number;
  frames: number; // Actual frame count (1-8)
  loop: boolean;
}

/**
 * Tile Atlas Layout
 *
 * Columns: N variations (tile_0, tile_1, ...)
 * Rows: 9 total
 *   Row 0: base tiles
 *   Row 1-8: transitions (n, ne, e, se, s, sw, w, nw)
 */
export interface TileAtlasSchema {
  type: 'tile';
  id: string;
  name: string;
  spriteSize: number;
  columns: number; // Number of variations
  rows: TileRow[];
}

export interface TileRow {
  type: 'base' | 'transition';
  transition?: TileTransition; // For transition rows
  row: number;
}

/**
 * Weapon Atlas Layout
 *
 * Columns: 8 (frames 0-7)
 * Rows: one per animation (sorted alphabetically)
 *
 * Example:
 *   Row 0: idle (8 frames, looping)
 *   Row 1: landed (1 frame, not looping)
 */
export interface WeaponAtlasSchema {
  type: 'weapon';
  id: string;
  name: string;
  spriteSize: number;
  columns: number; // Always MAX_FRAMES (8)
  rows: WeaponAnimationRow[];
  anchorX: number;
  anchorY: number;
}

export interface WeaponAnimationRow {
  animation: string;
  row: number;
  frames: number;
  loop: boolean;
}

export type AtlasSchema = CharacterAtlasSchema | TileAtlasSchema | WeaponAtlasSchema;

// ============================================================================
// Schema Builders
// ============================================================================

/**
 * Build a character atlas schema from manifest data
 */
export function buildCharacterSchema(
  id: string,
  name: string,
  animations: Record<string, { row: number; frames: number; loop: boolean }>,
  spriteSize: number = SPRITE_SIZE
): CharacterAtlasSchema {
  const rows: CharacterAnimationRow[] = Object.entries(animations)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([animation, info]) => ({
      animation,
      row: info.row,
      frames: info.frames,
      loop: info.loop,
    }));

  return {
    type: 'character',
    id,
    name,
    spriteSize,
    columns: MAX_FRAMES,
    rows,
  };
}

/**
 * Build a tile atlas schema from manifest data
 */
export function buildTileSchema(
  id: string,
  name: string,
  variations: number,
  hasTransitions: boolean,
  spriteSize: number = SPRITE_SIZE
): TileAtlasSchema {
  const rows: TileRow[] = [{ type: 'base', row: 0 }];

  if (hasTransitions) {
    TILE_TRANSITIONS.forEach((trans, idx) => {
      rows.push({ type: 'transition', transition: trans, row: idx + 1 });
    });
  }

  return {
    type: 'tile',
    id,
    name,
    spriteSize,
    columns: variations,
    rows,
  };
}

/**
 * Build a weapon atlas schema from manifest data
 */
export function buildWeaponSchema(
  id: string,
  name: string,
  animations: Record<string, { row: number; frames: number; loop: boolean }>,
  anchorX: number,
  anchorY: number,
  spriteSize: number = SPRITE_SIZE
): WeaponAtlasSchema {
  const rows: WeaponAnimationRow[] = Object.entries(animations)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([animation, info]) => ({
      animation,
      row: info.row,
      frames: info.frames,
      loop: info.loop,
    }));

  return {
    type: 'weapon',
    id,
    name,
    spriteSize,
    columns: MAX_FRAMES,
    rows,
    anchorX,
    anchorY,
  };
}

// ============================================================================
// Sprite Extraction Helpers
// ============================================================================

export interface SpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Get the source rectangle for a character sprite
 */
export function getCharacterSpriteRect(
  schema: CharacterAtlasSchema,
  animation: string,
  frame: number
): SpriteRect | null {
  const row = schema.rows.find(r => r.animation === animation);
  if (!row || frame >= row.frames) return null;

  return {
    x: frame * schema.spriteSize,
    y: row.row * schema.spriteSize,
    width: schema.spriteSize,
    height: schema.spriteSize,
  };
}

/**
 * Get the source rectangle for a tile sprite
 */
export function getTileSpriteRect(
  schema: TileAtlasSchema,
  variation: number,
  transition?: TileTransition
): SpriteRect | null {
  if (variation >= schema.columns) return null;

  let rowIndex = 0;
  if (transition) {
    const row = schema.rows.find(r => r.type === 'transition' && r.transition === transition);
    if (!row) return null;
    rowIndex = row.row;
  }

  return {
    x: variation * schema.spriteSize,
    y: rowIndex * schema.spriteSize,
    width: schema.spriteSize,
    height: schema.spriteSize,
  };
}

/**
 * Get the source rectangle for a weapon sprite
 */
export function getWeaponSpriteRect(
  schema: WeaponAtlasSchema,
  animation: string,
  frame: number
): SpriteRect | null {
  const row = schema.rows.find(r => r.animation === animation);
  if (!row || frame >= row.frames) return null;

  return {
    x: frame * schema.spriteSize,
    y: row.row * schema.spriteSize,
    width: schema.spriteSize,
    height: schema.spriteSize,
  };
}

// ============================================================================
// Cell Identification (for editors)
// ============================================================================

export interface CharacterCell {
  type: 'character';
  animation: string;
  frame: number;
  row: number;
  col: number;
  isEmpty: boolean; // True if frame >= animation's frame count
}

export interface TileCell {
  type: 'tile';
  variation: number;
  transition: TileTransition | null; // null for base tile
  row: number;
  col: number;
}

export interface WeaponCell {
  type: 'weapon';
  animation: string;
  frame: number;
  row: number;
  col: number;
  isEmpty: boolean;
}

export type AtlasCell = CharacterCell | TileCell | WeaponCell;

/**
 * Get cell info at a pixel position in a character atlas
 */
export function getCharacterCellAt(
  schema: CharacterAtlasSchema,
  x: number,
  y: number
): CharacterCell | null {
  const col = Math.floor(x / schema.spriteSize);
  const row = Math.floor(y / schema.spriteSize);

  if (col < 0 || col >= schema.columns) return null;

  const animRow = schema.rows.find(r => r.row === row);
  if (!animRow) return null;

  return {
    type: 'character',
    animation: animRow.animation,
    frame: col,
    row,
    col,
    isEmpty: col >= animRow.frames,
  };
}

/**
 * Get cell info at a pixel position in a tile atlas
 */
export function getTileCellAt(
  schema: TileAtlasSchema,
  x: number,
  y: number
): TileCell | null {
  const col = Math.floor(x / schema.spriteSize);
  const row = Math.floor(y / schema.spriteSize);

  if (col < 0 || col >= schema.columns) return null;

  const tileRow = schema.rows.find(r => r.row === row);
  if (!tileRow) return null;

  return {
    type: 'tile',
    variation: col,
    transition: tileRow.type === 'transition' ? tileRow.transition! : null,
    row,
    col,
  };
}

/**
 * Get cell info at a pixel position in a weapon atlas
 */
export function getWeaponCellAt(
  schema: WeaponAtlasSchema,
  x: number,
  y: number
): WeaponCell | null {
  const col = Math.floor(x / schema.spriteSize);
  const row = Math.floor(y / schema.spriteSize);

  if (col < 0 || col >= schema.columns) return null;

  const animRow = schema.rows.find(r => r.row === row);
  if (!animRow) return null;

  return {
    type: 'weapon',
    animation: animRow.animation,
    frame: col,
    row,
    col,
    isEmpty: col >= animRow.frames,
  };
}
