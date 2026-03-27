/**
 * Character asset schemas — TypeScript mirror of the Rust types in
 * core/src/entities/asset_schema.rs and the JSON schemas in schemas/.
 *
 * These are the authoritative TypeScript interfaces for character data.
 * The CharacterEditor, baking pipeline, and runtime manifest loader
 * all use these types. If the schema changes, change it here and in
 * the Rust structs — both must agree.
 *
 * Storage backends (IDB, disk, S3) store these as JSON. The key
 * format for frame blobs is:
 *   characters/{id}/frames/{animation}/{direction}/{frame}.png
 */

// ── Source schema (pre-bake) ────────────────────────────────────────

/** A character asset as authored in the editor, before baking. */
export interface CharacterSourceDef {
  /** Schema version. Must be 1. */
  version: 1;
  /** Unique identifier (lowercase, alphanumeric + underscores). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Sprite size in pixels (width = height). Typically 128. */
  spriteSize: number;
  /** Seconds per frame for animation playback. Default 0.1. */
  frameDuration: number;
  /** Optional weapon/object asset reference. */
  weaponDefId?: string | null;
  /** Optional throwable/object asset reference. */
  throwableDefId?: string | null;
  /** Animation declarations. Key is animation name (e.g., "idle", "walk"). */
  animations: Record<string, AnimationDirections>;
  /** ISO 8601 creation timestamp. */
  createdAt?: string;
  /** ISO 8601 last modification timestamp. */
  updatedAt?: string;
}

/** Per-direction frame declarations for one animation. */
export interface AnimationDirections {
  north?: DirectionFrames;
  east?: DirectionFrames;
  /** South is always required (minimum viable animation). */
  south: DirectionFrames;
  west?: DirectionFrames;
}

/** Frame count and loop setting for one animation+direction. */
export interface DirectionFrames {
  /** Number of frames (1-8). */
  frames: number;
  /** Whether the animation loops. Default true. */
  loop?: boolean;
}

// ── Baked schema (post-bake, for runtime) ───────────────────────────

/** A character asset after baking — consumed by the game runtime. */
export interface CharacterBakedDef {
  /** Schema version. Must be 1. */
  version: 1;
  /** Character identifier (matches source). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Relative path to atlas PNG from assets root. */
  atlas: string;
  /** Atlas image width in pixels. */
  atlasWidth: number;
  /** Atlas image height in pixels. */
  atlasHeight: number;
  /** Sprite cell size in the atlas. */
  spriteSize: number;
  /** Default seconds per frame. */
  frameDuration: number;
  /** Baked animation entries. Key: "{animation}_{direction}". */
  animations: Record<string, BakedAnimation>;
  /** Passthrough from source. */
  weaponDefId?: string | null;
  /** Passthrough from source. */
  throwableDefId?: string | null;
}

/** One animation+direction in the baked atlas. */
export interface BakedAnimation {
  /** Row index in the atlas (0-based). */
  row: number;
  /** Number of frames in this row. */
  frames: number;
  /** Whether this animation loops. */
  loop: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** All valid direction names. */
export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const;
export type Direction = typeof DIRECTIONS[number];

/**
 * Enumerate all (animation, direction, frameIndex) triples declared
 * in a source definition.
 */
export function sourceFrameKeys(
  def: CharacterSourceDef,
): Array<{ animation: string; direction: Direction; frame: number }> {
  const keys: Array<{ animation: string; direction: Direction; frame: number }> = [];
  for (const [anim, dirs] of Object.entries(def.animations)) {
    for (const dir of DIRECTIONS) {
      const df = dirs[dir];
      if (df) {
        for (let f = 0; f < df.frames; f++) {
          keys.push({ animation: anim, direction: dir, frame: f });
        }
      }
    }
  }
  return keys;
}

/**
 * Build the storage path for a frame blob.
 * E.g., `characters/hotdogguy/frames/idle/south/0.png`
 */
export function framePath(
  id: string,
  animation: string,
  direction: string,
  frame: number,
): string {
  return `characters/${id}/frames/${animation}/${direction}/${frame}.png`;
}

const ID_REGEX = /^[a-z][a-z0-9_]*$/;
const VALID_SPRITE_SIZES = [64, 128, 256];

/**
 * Validate a source definition against the schema constraints.
 * Enforces: version, id regex, name non-empty, spriteSize enum,
 * animation name regex, frame count range.
 * Returns error messages (empty = valid).
 */
export function validateSourceDef(def: CharacterSourceDef): string[] {
  const errors: string[] = [];

  if (def.version !== 1) errors.push(`unsupported version: ${def.version}`);
  if (!def.id) {
    errors.push('id is empty');
  } else if (!ID_REGEX.test(def.id)) {
    errors.push(`id '${def.id}': must match ^[a-z][a-z0-9_]*$`);
  }
  if (!def.name) errors.push('name is empty');
  if (!VALID_SPRITE_SIZES.includes(def.spriteSize)) {
    errors.push(`spriteSize must be 64, 128, or 256, got ${def.spriteSize}`);
  }

  const animKeys = Object.keys(def.animations);
  if (animKeys.length === 0) errors.push('no animations declared');

  for (const [anim, dirs] of Object.entries(def.animations)) {
    if (!ID_REGEX.test(anim)) {
      errors.push(`animation name '${anim}': must match ^[a-z][a-z0-9_]*$`);
    }
    const checkDir = (dirName: string, df: DirectionFrames | undefined) => {
      if (!df) return;
      if (df.frames < 1 || df.frames > 8) {
        errors.push(`${anim}/${dirName}: frames must be 1..8, got ${df.frames}`);
      }
    };
    checkDir('north', dirs.north);
    checkDir('east', dirs.east);
    checkDir('south', dirs.south);
    checkDir('west', dirs.west);
  }

  return errors;
}
