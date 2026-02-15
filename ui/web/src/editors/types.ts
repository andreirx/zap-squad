/**
 * Shared types for editor components
 */

/** RGBA color */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Point in canvas coordinates */
export interface Point {
  x: number;
  y: number;
}

/** Rectangle selection */
export interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Drawing tool types */
export type Tool = 'pencil' | 'eraser' | 'fill' | 'select' | 'line' | 'eyedropper';

/** Animation state for characters */
export type AnimationState = 'idle' | 'walk' | 'melee_attack' | 'throw_attack';

/** Visual state for damage levels */
export type VisualState = 'full' | 'hurt_1' | 'hurt_2' | 'critical';

/** Direction for sprite variants */
export type Direction = 'north' | 'east' | 'south' | 'west';

/** Character definition saved to storage */
export interface CharacterDefinition {
  id: string;
  name: string;
  frames: number;
  frameDuration: number;
  createdAt: string;
  updatedAt: string;
}

/** Weapon definition saved to storage */
export interface WeaponDefinition {
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

/** Tile definition saved to storage */
export interface TileDefinition {
  id: string;
  name: string;
  walkable: boolean;
  blocksVision: boolean;
  damagePerTurn: number;
  createdAt: string;
  updatedAt: string;
}

/** Canvas layer for compositing */
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  data: ImageData;
}

/** History entry for undo/redo */
export interface HistoryEntry {
  data: ImageData;
  timestamp: number;
}

/** Sprite key for naming convention */
export interface SpriteKey {
  bodyId: string;
  visualState: VisualState;
  animationState: AnimationState;
  direction: Direction;
  frame: number;
}

/** Build sprite filename from key */
export function buildSpriteName(key: SpriteKey): string {
  return `${key.bodyId}_${key.visualState}_${key.animationState}_${key.direction}_${key.frame}.png`;
}

/** Parse sprite filename to key */
export function parseSpriteName(filename: string): SpriteKey | null {
  const match = filename.match(/^(.+)_(full|hurt_1|hurt_2|critical)_(idle|walk|melee_attack|throw_attack)_(north|east|south|west)_(\d+)\.png$/);
  if (!match) return null;
  return {
    bodyId: match[1],
    visualState: match[2] as VisualState,
    animationState: match[3] as AnimationState,
    direction: match[4] as Direction,
    frame: parseInt(match[5], 10),
  };
}

/** All animation states */
export const ANIMATION_STATES: AnimationState[] = ['idle', 'walk', 'melee_attack', 'throw_attack'];

/** All visual states */
export const VISUAL_STATES: VisualState[] = ['full', 'hurt_1', 'hurt_2', 'critical'];

/** All directions */
export const DIRECTIONS: Direction[] = ['north', 'east', 'south', 'west'];

/** Default frame count per animation */
export const DEFAULT_FRAMES = 4;

/** Default frame duration in seconds */
export const DEFAULT_FRAME_DURATION = 0.1;
