/** Drawing tool identifiers for the freedom-board infinite canvas. */
export type Tool = 'pan' | 'draw' | 'erase' | 'fill' | 'line' | 'rect' | 'character';

/** Summary stats from the WASM world state, reported via game events. */
export interface WorldStats {
  tileCount: number;
  chunkCount: number;
}
