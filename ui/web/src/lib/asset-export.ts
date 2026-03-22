/**
 * Asset export/import for individual tiles, characters, and weapons.
 *
 * Export format: JSON with metadata + base64-encoded atlas PNG.
 * Import: parse JSON, decode base64 PNG, write to IDB via fileStore.
 *
 * Compatible with the manifest loader — imported assets appear in the
 * AssetPanel after the next manifest reload.
 */

import { ASSETS_URL } from './config';

/** Portable asset export format. */
export interface AssetExport {
  type: 'tile' | 'character' | 'weapon';
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  /** Base64-encoded PNG atlas. */
  atlas: string;
  atlasWidth: number;
  atlasHeight: number;
  spriteSize: number;
  exportedAt: number;
}

/**
 * Export a single asset as a downloadable JSON file.
 *
 * Fetches the atlas PNG from the assets URL, encodes it as base64,
 * packages it with the asset metadata, and triggers a browser download.
 */
export async function exportAsset(
  type: 'tile' | 'character' | 'weapon',
  def: {
    id: string;
    name: string;
    atlas: string;
    atlasWidth?: number;
    atlasHeight?: number;
    spriteSize: number;
  },
): Promise<void> {
  // Fetch the atlas PNG
  const atlasUrl = `${ASSETS_URL}/${def.atlas}`;
  const resp = await fetch(atlasUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch atlas: ${resp.status} ${atlasUrl}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);

  // Collect all extra fields as metadata
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) {
    if (!['id', 'name', 'atlas', 'atlasWidth', 'atlasHeight', 'spriteSize'].includes(k)) {
      metadata[k] = v;
    }
  }

  const exportData: AssetExport = {
    type,
    id: def.id,
    name: def.name,
    metadata,
    atlas: base64,
    atlasWidth: def.atlasWidth ?? def.spriteSize,
    atlasHeight: def.atlasHeight ?? def.spriteSize,
    spriteSize: def.spriteSize,
    exportedAt: Date.now(),
  };

  // Trigger download
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${type}-${def.id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(`[asset-export] exported ${type} "${def.id}" (${json.length} bytes)`);
}

/**
 * Import an asset from a JSON file.
 *
 * Parses the AssetExport format, decodes the base64 PNG, and writes
 * both the metadata and atlas blob to IDB via fileStore.
 *
 * Returns the parsed asset definition so the caller can update the UI.
 */
export async function importAsset(
  jsonText: string,
): Promise<AssetExport> {
  const data = JSON.parse(jsonText) as AssetExport;

  if (!data.type || !data.id || !data.atlas) {
    throw new Error('Invalid asset export: missing type, id, or atlas');
  }

  // Decode base64 atlas to ArrayBuffer
  const atlasBuffer = base64ToArrayBuffer(data.atlas);

  // Write to IDB via fileStore
  const { fileStore } = await import('./idb');

  // Store atlas PNG
  const atlasPath = `${data.type}s/${data.id}/${data.id}_atlas.png`;
  await fileStore.save(`mods/${atlasPath}`, atlasBuffer, 'image/png');

  // Store definition JSON
  const defPath = `${data.type}s/${data.id}/definition.json`;
  const defJson = JSON.stringify({
    id: data.id,
    name: data.name,
    spriteSize: data.spriteSize,
    atlasWidth: data.atlasWidth,
    atlasHeight: data.atlasHeight,
    ...data.metadata,
  });
  const defBuffer = new TextEncoder().encode(defJson);
  await fileStore.save(`mods/${defPath}`, defBuffer.buffer as ArrayBuffer, 'application/json');

  console.log(`[asset-import] imported ${data.type} "${data.id}"`);
  return data;
}

/**
 * Open a file picker for importing an asset JSON file.
 * Returns the parsed AssetExport, or null if the user cancels.
 */
export function pickAndImportAsset(): Promise<AssetExport | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        const asset = await importAsset(text);
        resolve(asset);
      } catch (err) {
        console.error('[asset-import] failed:', err);
        resolve(null);
      }
    };
    input.click();
  });
}

// ── Base64 helpers ──────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}
