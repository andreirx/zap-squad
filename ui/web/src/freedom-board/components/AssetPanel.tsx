import { useState } from 'react';
import type { TileDefinition, CharacterDefinition, WeaponDefinition } from '../lib/manifest';
import { ASSETS_URL } from '../../lib/config';

/** Preview thumbnail size in CSS pixels. */
const THUMB = 48;

interface AssetPanelProps {
  tiles: TileDefinition[];
  characters: CharacterDefinition[];
  weapons: WeaponDefinition[];
  activeAssetId: number;
  onAssetChange: (id: number) => void;
  activeCharacterId: number;
  onCharacterChange: (id: number) => void;
}

/** Categorize tiles by tileType for the collapsible sections. */
type Category = 'TILE' | 'PATH' | 'BRIDGE';

const CATEGORY_LABELS: Record<Category, string> = {
  TILE: 'Terrain',
  PATH: 'Paths',
  BRIDGE: 'Bridges',
};

const CATEGORY_ORDER: Category[] = ['TILE', 'PATH', 'BRIDGE'];

/**
 * Sprite preview using CSS background-image to crop the first frame
 * (row 0, col 0) from an atlas sheet.
 *
 * How it works:
 * - The atlas PNG contains a grid of sprites (cols x rows).
 * - We set background-size to scale the entire atlas so each sprite
 *   maps to THUMB x THUMB CSS pixels.
 * - background-position: 0 0 selects the top-left sprite (frame 0).
 */
function SpritePreview({ atlas, spriteSize, atlasWidth, atlasHeight }: {
  atlas: string;
  spriteSize: number;
  atlasWidth?: number;
  atlasHeight?: number;
}) {
  const scale = THUMB / spriteSize;
  const bgW = (atlasWidth ?? spriteSize) * scale;
  const bgH = (atlasHeight ?? spriteSize) * scale;

  return (
    <div
      style={{
        width: THUMB,
        height: THUMB,
        backgroundImage: `url(${ASSETS_URL}/${atlas})`,
        backgroundSize: `${bgW}px ${bgH}px`,
        backgroundPosition: '0 0',
        backgroundRepeat: 'no-repeat',
        borderRadius: 3,
        imageRendering: 'pixelated',
        flexShrink: 0,
      }}
    />
  );
}

/** Terrain type badge — color-coded LAND vs WATER. */
function TerrainBadge({ terrain }: { terrain: string }) {
  const isWater = terrain === 'WATER';
  return (
    <span style={{
      fontSize: 9,
      padding: '1px 4px',
      borderRadius: 2,
      background: isWater ? '#1a3a5c' : '#2a3a1c',
      color: isWater ? '#6ab0e0' : '#8ac060',
      whiteSpace: 'nowrap',
    }}>
      {isWater ? 'WATER' : 'LAND'}
    </span>
  );
}

/** Collapsible section with header and child content. */
function Section({ label, count, defaultOpen, children }: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          background: '#0f1a30',
          border: 'none',
          borderBottom: '1px solid #0f3460',
          color: '#c0c8d0',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 9, color: '#556677' }}>{open ? '\u25BC' : '\u25B6'}</span>
        {label}
        <span style={{ fontSize: 9, color: '#556677', marginLeft: 'auto' }}>({count})</span>
      </button>
      {open && (
        <div style={{ padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Side panel displaying categorized tile, character, and weapon cards.
 *
 * Tile cards show:
 * - Atlas sprite preview (first frame, 48x48)
 * - Tile name and ID
 * - Terrain type badge (LAND/WATER)
 * - Variation count
 *
 * TECH DEBT: passable and movementCost are in per-tile properties.json
 * files, not in manifest.json. Would need either:
 * (a) 18 parallel fetch calls to /mods/tiles/{id}/properties.json, or
 * (b) extending the bake-atlases script to merge properties into manifest.
 * For now, only terrainType is shown. movementCost display deferred.
 */
export function AssetPanel({
  tiles,
  characters,
  weapons,
  activeAssetId,
  onAssetChange,
  activeCharacterId,
  onCharacterChange,
}: AssetPanelProps) {
  // Group tiles by category, preserving their index in the sorted array
  // (the index IS the asset_id used by WASM)
  const grouped = CATEGORY_ORDER.map(cat => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    items: tiles
      .map((t, index) => ({ tile: t, index }))
      .filter(({ tile }) => tile.tileType === cat),
  })).filter(g => g.items.length > 0);

  return (
    <div style={{
      width: 220,
      minWidth: 220,
      height: '100%',
      background: '#0d1525',
      borderRight: '1px solid #0f3460',
      overflowY: 'auto',
      overflowX: 'hidden',
      fontSize: 11,
      userSelect: 'none',
    }}>
      {/* Tile categories */}
      {grouped.map(({ category, label, items }) => (
        <Section key={category} label={label} count={items.length} defaultOpen>
          {items.map(({ tile, index }) => (
            <button
              key={tile.id}
              onClick={() => onAssetChange(index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
                background: activeAssetId === index ? '#1a2a4a' : 'transparent',
                border: activeAssetId === index ? '1px solid #e94560' : '1px solid transparent',
                borderRadius: 4,
                cursor: 'pointer',
                width: '100%',
                textAlign: 'left',
              }}
            >
              <SpritePreview
                atlas={tile.atlas}
                spriteSize={tile.spriteSize}
                atlasWidth={tile.atlasWidth}
                atlasHeight={tile.atlasHeight}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  color: activeAssetId === index ? '#e94560' : '#c0c8d0',
                  fontSize: 11,
                  fontWeight: activeAssetId === index ? 600 : 400,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {tile.name}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 2, alignItems: 'center' }}>
                  <TerrainBadge terrain={tile.terrainType} />
                  <span style={{ fontSize: 9, color: '#556677' }}>{tile.variations}v</span>
                </div>
              </div>
            </button>
          ))}
        </Section>
      ))}

      {/* Characters — selectable; index = body_def_index sent to WASM */}
      {characters.length > 0 && (
        <Section label="Characters" count={characters.length} defaultOpen>
          {characters.map((c, index) => (
            <button
              key={c.id}
              onClick={() => onCharacterChange(index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
                background: activeCharacterId === index ? '#1a2a4a' : 'transparent',
                border: activeCharacterId === index ? '1px solid #60a0e0' : '1px solid transparent',
                borderRadius: 4,
                cursor: 'pointer',
                width: '100%',
                textAlign: 'left',
              }}
            >
              <SpritePreview atlas={c.atlas} spriteSize={c.spriteSize} />
              <div style={{
                color: activeCharacterId === index ? '#60a0e0' : '#c0c8d0',
                fontSize: 11,
                fontWeight: activeCharacterId === index ? 600 : 400,
              }}>
                {c.name}
              </div>
            </button>
          ))}
          <div style={{ fontSize: 9, color: '#445566', padding: '2px 6px' }}>
            Char tool (C): click to place, right-click to move selected, Del to remove
          </div>
        </Section>
      )}

      {/* Weapons/Objects */}
      {weapons.length > 0 && (
        <Section label="Weapons" count={weapons.length} defaultOpen={false}>
          {weapons.map(w => (
            <div
              key={w.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
              }}
            >
              <SpritePreview atlas={w.atlas} spriteSize={w.spriteSize} />
              <div style={{ color: '#c0c8d0', fontSize: 11 }}>{w.name}</div>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
