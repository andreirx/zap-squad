/** Drawing tool identifiers for the freedom-board infinite canvas. */
export type Tool = 'pan' | 'draw' | 'erase' | 'fill' | 'line' | 'rect' | 'character';

/** Summary stats from the WASM world state, reported via game events. */
export interface WorldStats {
  tileCount: number;
  chunkCount: number;
}

/** Resolved stamp tile (relative coordinates, no origin yet). */
export interface StampTile {
  x: number;
  y: number;
  assetId: number;
  layer: number;
  variant: number;
}

/** A parsed map waiting for the user to pick a placement position. */
export interface PendingPlacement {
  tiles: StampTile[];
  /** Map width in tiles. */
  widthTiles: number;
  /** Map height in tiles. */
  heightTiles: number;
  /** Level name from the LDtk file. */
  levelName: string;
}
