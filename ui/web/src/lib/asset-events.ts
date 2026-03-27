/**
 * Asset lifecycle events for cross-surface refresh.
 *
 * These events are UI-level coordination only. They do not define asset
 * semantics. Source definitions remain authoritative; listeners use these
 * events to refresh derived views (Freedom Board palette, merged runtime
 * registry) after a successful save+bake cycle.
 */

export const CHARACTER_ASSETS_CHANGED_EVENT = 'zapsquad:character-assets-changed';

export interface CharacterAssetsChangedDetail {
  characterId: string;
  bakedAt: string;
}

export function emitCharacterAssetsChanged(detail: CharacterAssetsChangedDetail): void {
  window.dispatchEvent(new CustomEvent<CharacterAssetsChangedDetail>(
    CHARACTER_ASSETS_CHANGED_EVENT,
    { detail },
  ));
}

export function onCharacterAssetsChanged(
  listener: (detail: CharacterAssetsChangedDetail) => void,
): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<CharacterAssetsChangedDetail>;
    listener(custom.detail);
  };
  window.addEventListener(CHARACTER_ASSETS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(CHARACTER_ASSETS_CHANGED_EVENT, handler);
}
