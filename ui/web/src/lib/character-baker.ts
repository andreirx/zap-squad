/**
 * Character baker orchestrator — coordinates wasm-baker + Canvas API + IDB.
 *
 * This module is pure orchestration. It does not invent format semantics.
 * All policy decisions (atlas layout, metadata generation, validation)
 * are delegated to the wasm-baker crate. This module handles:
 *   - loading the WASM module lazily
 *   - reading source frame blobs from IDB
 *   - compositing the atlas with Canvas API
 *   - storing baked outputs (atlas PNG, baked def, sprite entries) in IDB
 *   - returning a structured result to callers
 *
 * The baked outputs are stored under a well-known IDB prefix so the
 * runtime registry merger can find them without rebuilding the app.
 */

import { createStorage } from '../storage';
import { fileStore } from './idb';
import { framePath } from '../schemas/character';

// ── Types ─────────────────────────────────────────────────────────────

/** Result of a bake operation. */
export interface BakeResult {
  success: boolean;
  /** Character ID that was baked. */
  characterId: string;
  /** Errors (empty on success). */
  errors: string[];
  /** Number of frames composited into the atlas. */
  framesComposited?: number;
  /** Atlas dimensions in pixels. */
  atlasWidth?: number;
  atlasHeight?: number;
}

/** Atlas plan from wasm-baker. */
interface AtlasPlan {
  width: number;
  height: number;
  cols: number;
  rows: number;
  spriteSize: number;
  placements: Array<{
    animation: string;
    direction: string;
    frame: number;
    col: number;
    row: number;
  }>;
}

/** Sprite entry for the registry. */
interface SpriteEntry {
  atlas: number;
  col: number;
  row: number;
}

// ── WASM module singleton ─────────────────────────────────────────────

let wasmMod: {
  validate_source: (json: string) => string;
  plan_atlas: (json: string) => string;
  generate_baked_def: (json: string, atlasPath: string) => string;
  generate_sprite_entries: (json: string, atlasIndex: number) => string;
} | null = null;

async function loadWasm(): Promise<typeof wasmMod> {
  if (wasmMod) return wasmMod;
  const mod = await import('../wasm-baker/wasm_baker');
  await mod.default();
  wasmMod = mod;
  return wasmMod;
}

/** Unwrap the { ok, error } envelope from a wasm-baker export. */
function unwrapResult<T>(json: string): { ok: T } | { error: string } {
  const parsed = JSON.parse(json);
  if (parsed.error) return { error: parsed.error };
  return { ok: parsed.ok };
}

// ── IDB keys for baked outputs ────────────────────────────────────────
// Baked outputs are stored directly in fileStore under the `baked/` namespace.
// This is derived-cache space, separate from `mods/` (source space).
//
// `mods/` = source assets (written by editors via IdbStorage adapter)
// `baked/` = derived cache (written by baker directly to fileStore)
//
// Export/import must move source assets, not baked artifacts.
// Baked artifacts are regenerated from source on import.

const BAKED_PREFIX = 'baked/characters';

function bakedAtlasKey(id: string): string {
  return `${BAKED_PREFIX}/${id}/atlas.png`;
}

function bakedDefKey(id: string): string {
  return `${BAKED_PREFIX}/${id}/baked.json`;
}

function bakedSpriteEntriesKey(id: string): string {
  return `${BAKED_PREFIX}/${id}/sprites.json`;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Bake a character from its source definition + frame blobs in IDB.
 *
 * Steps:
 * 1. Read CharacterSourceDef from IDB
 * 2. Validate via wasm-baker
 * 3. Plan atlas layout via wasm-baker
 * 4. Read all declared frame blobs from IDB
 * 5. Composite atlas with Canvas API
 * 6. Store atlas PNG blob in IDB
 * 7. Generate baked def and sprite entries via wasm-baker
 * 8. Store baked def and sprite entries in IDB
 *
 * Returns a structured BakeResult.
 */
export async function bakeCharacter(characterId: string): Promise<BakeResult> {
  const fail = (errors: string[]): BakeResult => ({
    success: false,
    characterId,
    errors,
  });

  try {
    // 1. Load WASM baker
    const wasm = await loadWasm();
    if (!wasm) return fail(['Failed to load wasm-baker module']);

    // 2. Read source definition from IDB
    const storage = createStorage();
    let sourceJson: string;
    try {
      sourceJson = await storage.readText(`characters/${characterId}/definition.json`);
    } catch {
      return fail([`Source definition not found: characters/${characterId}/definition.json`]);
    }

    // 3. Validate
    const valResult = unwrapResult<{ valid: boolean; errors: string[] }>(
      wasm.validate_source(sourceJson)
    );
    if ('error' in valResult) return fail([valResult.error]);
    if (!valResult.ok.valid) return fail(valResult.ok.errors);

    // 4. Plan atlas
    const planResult = unwrapResult<AtlasPlan>(wasm.plan_atlas(sourceJson));
    if ('error' in planResult) return fail([planResult.error]);
    const plan = planResult.ok;

    if (plan.placements.length === 0) {
      return fail(['No frame placements — character has no declared frames']);
    }

    // 5. Load frame blobs and composite atlas
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return fail(['Failed to create canvas 2d context']);

    // Transparent background (default)
    ctx.imageSmoothingEnabled = false;
    let framesComposited = 0;

    const missingBlobs: string[] = [];
    for (const p of plan.placements) {
      const path = framePath(characterId, p.animation, p.direction, p.frame);
      try {
        const blob = await storage.readBytes(path);
        const img = await loadImageFromArrayBuffer(blob);
        const x = p.col * plan.spriteSize;
        const y = p.row * plan.spriteSize;
        ctx.drawImage(img, x, y, plan.spriteSize, plan.spriteSize);
        framesComposited++;
      } catch {
        missingBlobs.push(path);
      }
    }

    // Declared frames must all exist. Missing blobs are a hard error —
    // the source contract says the definition is authoritative over
    // what frames exist, and the baker must not produce partial output.
    if (missingBlobs.length > 0) {
      return fail([
        `${missingBlobs.length} declared frame(s) missing from storage:`,
        ...missingBlobs.map(p => `  ${p}`),
      ]);
    }

    if (framesComposited === 0) {
      return fail(['No frame blobs found — nothing to composite']);
    }

    // 6. Export atlas as PNG blob and store in IDB
    const atlasBlob = await canvasToBlob(canvas);
    const atlasBuffer = await atlasBlob.arrayBuffer();
    await fileStore.save(bakedAtlasKey(characterId), atlasBuffer, 'image/png');

    // 7. Generate baked definition
    const atlasPath = `characters/${characterId}.png`;
    const bakedDefResult = unwrapResult<Record<string, unknown>>(
      wasm.generate_baked_def(sourceJson, atlasPath)
    );
    if ('error' in bakedDefResult) return fail([bakedDefResult.error]);
    await fileStore.save(
      bakedDefKey(characterId),
      new TextEncoder().encode(JSON.stringify(bakedDefResult.ok)).buffer as ArrayBuffer,
      'application/json'
    );

    // 8. Generate sprite registry entries
    // Atlas index will be assigned by the registry merger at runtime.
    // Store with placeholder index 0 — merger reassigns.
    const spriteResult = unwrapResult<Record<string, SpriteEntry>>(
      wasm.generate_sprite_entries(sourceJson, 0)
    );
    if ('error' in spriteResult) return fail([spriteResult.error]);
    await fileStore.save(
      bakedSpriteEntriesKey(characterId),
      new TextEncoder().encode(JSON.stringify(spriteResult.ok)).buffer as ArrayBuffer,
      'application/json'
    );

    console.log(
      `[baker] baked "${characterId}": ${framesComposited} frames, ` +
      `${plan.width}x${plan.height} atlas, ${Object.keys(spriteResult.ok).length} sprite entries`
    );

    return {
      success: true,
      characterId,
      errors: [],
      framesComposited,
      atlasWidth: plan.width,
      atlasHeight: plan.height,
    };
  } catch (err) {
    return fail([`Unexpected error: ${err instanceof Error ? err.message : String(err)}`]);
  }
}

/**
 * List all baked character IDs by scanning IDB for baked definition files.
 * Scans the `baked/` namespace directly in fileStore (not `mods/`).
 */
export async function listBakedCharacters(): Promise<string[]> {
  const allKeys = await fileStore.list();
  const prefix = `${BAKED_PREFIX}/`;
  const suffix = '/baked.json';
  const ids = new Set<string>();
  for (const key of allKeys) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      const id = key.slice(prefix.length, key.length - suffix.length);
      if (id) ids.add(id);
    }
  }
  return Array.from(ids).sort();
}

/**
 * Read a baked character's definition from IDB.
 * Returns null if not baked yet.
 */
export async function readBakedDef(characterId: string): Promise<Record<string, unknown> | null> {
  const record = await fileStore.load(bakedDefKey(characterId));
  if (!record) return null;
  try {
    const text = new TextDecoder().decode(record.data);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read a baked character's sprite entries from IDB.
 * Returns null if not baked yet.
 */
export async function readBakedSpriteEntries(
  characterId: string,
): Promise<Record<string, SpriteEntry> | null> {
  const record = await fileStore.load(bakedSpriteEntriesKey(characterId));
  if (!record) return null;
  try {
    const text = new TextDecoder().decode(record.data);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read a baked character's atlas PNG as an object URL.
 * Returns null if not baked yet. Caller must revoke the URL when done.
 */
export async function readBakedAtlasUrl(characterId: string): Promise<string | null> {
  const record = await fileStore.load(bakedAtlasKey(characterId));
  if (!record) return null;
  const blob = new Blob([record.data], { type: 'image/png' });
  return URL.createObjectURL(blob);
}

// ── Internal helpers ──────────────────────────────────────────────────

function loadImageFromArrayBuffer(buffer: ArrayBuffer): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load frame image'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob returned null'));
      },
      'image/png',
    );
  });
}
