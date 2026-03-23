/**
 * Canonical tile layer assignment.
 *
 * SINGLE SOURCE OF TRUTH for how tile types map to storage layers.
 * Used by: freedom-board (InfiniteCanvas), map editor, LDtk import.
 *
 * | Layer | Content          | Condition                    |
 * |-------|------------------|------------------------------|
 * | 0     | Ground (terrain) | tileType = TILE              |
 * | 1     | Rivers           | tileType = PATH, water       |
 * | 2     | Bridges          | tileType = BRIDGE            |
 * | 3     | Roads            | tileType = PATH, land        |
 *
 * The WASM side has equivalent logic in storage_to_render_layer().
 * If you change this, update the Rust side too.
 */

export function tileTypeToLayer(entry: { tileType?: string; terrainType?: string } | undefined): number {
  if (!entry) return 0;
  if (entry.tileType === 'BRIDGE') return 2;
  if (entry.tileType === 'PATH') {
    return entry.terrainType === 'WATER' ? 1 : 3;
  }
  return 0;
}
