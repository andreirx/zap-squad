# ZAP-SQUAD Asset Schema

This document defines the schema for all game assets, ported from hexmanos with visual state support.

## Core Constants

```typescript
SPRITE_SIZE = 128          // All sprites are 128x128 pixels
MAX_FRAMES = 8             // Maximum frames per animation
PATH_FADE_PIXELS = 4       // Fade distance on path interior edges
DEFAULT_PATH_WIDTH = 56    // Default center width for paths
DEFAULT_BRIDGE_WIDTH = 72  // Default center width for bridges
```

---

## 1. CHARACTERS

Characters are animated entities with visual states, movement, and combat animations.

### Definition Schema

```typescript
interface CharacterDefinition {
  id: string;
  name: string;
  frameDuration: number;      // Seconds per frame (default: 0.1)
  createdAt: string;
  updatedAt: string;
}
```

### Visual States (Health-Based Appearance)

| State | Health Range | Description |
|-------|--------------|-------------|
| full | 75-100% | Normal appearance |
| hurt1 | 50-74% | Light damage |
| hurt2 | 25-49% | Heavy damage |
| critical | 0-24% | Near death |

### Animation States

| State | Required | Loop | Description |
|-------|----------|------|-------------|
| idle_north | Yes | Yes | Standing facing north |
| idle_east | Yes | Yes | Standing facing east |
| idle_south | Yes | Yes | Standing facing south |
| idle_west | Yes | Yes | Standing facing west |
| walk_north | Yes | Yes | Walking north |
| walk_east | Yes | Yes | Walking east |
| walk_south | Yes | Yes | Walking south |
| walk_west | Yes | Yes | Walking west |
| melee_attack_north | No | No | Melee attack facing north |
| melee_attack_east | No | No | Melee attack facing east |
| melee_attack_south | No | No | Melee attack facing south |
| melee_attack_west | No | No | Melee attack facing west |
| throw_attack_north | No | No | Ranged attack facing north |
| throw_attack_east | No | No | Ranged attack facing east |
| throw_attack_south | No | No | Ranged attack facing south |
| throw_attack_west | No | No | Ranged attack facing west |

### File Structure

```
mods/characters/{id}/
├── definition.json
├── {id}_full_idle_south_0.png      # Default appearance
├── {id}_full_idle_south_1.png
├── {id}_full_walk_east_0.png
├── {id}_hurt1_idle_south_0.png     # Damaged appearance
├── {id}_critical_idle_south_0.png  # Near-death appearance
└── ...
```

### File Naming

```
{id}_{visualState}_{animation}_{direction}_{frame}.png
```

Examples:
- `zombie_full_idle_south_0.png` - Healthy zombie facing south
- `zombie_hurt2_walk_east_1.png` - Heavily damaged zombie walking east

---

## 2. OBJECTS

Objects are simplified entities with visual states and idle/landed animations. Used for projectiles, items, decorations.

### Definition Schema

```typescript
interface ObjectDefinition {
  id: string;
  name: string;
  frameDuration: number;
  createdAt: string;
  updatedAt: string;
}
```

### Visual States (Condition-Based)

| State | Description |
|-------|-------------|
| new | Brand new/pristine |
| worn | Slightly used |
| damaged | Visibly damaged |
| broken | Nearly destroyed |

### Animation States

| State | Required | Loop | Description |
|-------|----------|------|-------------|
| idle | Yes | Yes | Default state (flying projectile, spinning item) |
| landed | No | No | Impact/stopped state (projectile hit, item dropped) |

### File Structure

```
mods/objects/{id}/
├── definition.json
├── {id}_new_idle_0.png           # Default appearance
├── {id}_new_idle_1.png
├── {id}_new_landed_0.png
├── {id}_damaged_idle_0.png       # Damaged appearance
└── ...
```

### File Naming

```
{id}_{visualState}_{animation}_{frame}.png
```

---

## 3. TILES

Tiles are terrain elements with three types: basic terrain, paths, and bridges.

### Definition Schema

```typescript
interface TileDefinition {
  id: string;
  name: string;
  tileType: "TILE" | "PATH" | "BRIDGE";
  terrainType: "LAND" | "WATER";
  passable: boolean;
  movementCost: number;       // 0=impassable, 1=easy, 2+=difficult
  variations: number;         // 1-8 for TILE, exactly 15 for PATH/BRIDGE
  pathWidth?: number;         // For PATH/BRIDGE: center width in pixels
  bridgeAssetId?: string;     // For LAND PATH: which bridge to render over water
  createdAt: string;
  updatedAt: string;
}
```

### Tile Types

#### TILE (Basic Terrain)
- 1-8 random variations
- Used for grass, water, stone, dirt, etc.
- Passability is configurable

#### PATH (Walkways/Rivers)
- Exactly 15 directional variations
- LAND terrain: passable walkways/roads
- WATER terrain: non-passable rivers/streams
- Auto-connects based on adjacent paths of the same type
- LAND paths can specify `bridgeAssetId` for water crossings

#### BRIDGE
- Exactly 15 directional variations
- Always LAND terrain, always passable
- Auto-rendered when LAND PATH crosses water terrain or water paths
- Connectivity matches the path type above it

### Bridge Rendering Logic

When a ground path (PATH + LAND) is placed over water terrain or a water path (river):
1. The renderer detects the overlap
2. Looks up the path's `bridgeAssetId`
3. Renders the bridge tile UNDER the path
4. Bridge connectivity matches the path connectivity (same neighbors = same shape)
5. Different path types crossing the same water do NOT have connected bridges

### Path Connectivity Bitmask

Connectivity is calculated using a 4-bit bitmask:
- N (North) = 8
- S (South) = 4
- W (West) = 2
- E (East) = 1

Variation index = (bits === 0) ? 0 : bits - 1

### Path Direction Combinations (15 total)

| Index | N | S | W | E | Bits | Description |
|-------|---|---|---|---|------|-------------|
| 0 | | | | ✓ | 1 | Right only |
| 1 | | | ✓ | | 2 | Left only |
| 2 | | | ✓ | ✓ | 3 | Horizontal |
| 3 | | ✓ | | | 4 | Down only |
| 4 | | ✓ | | ✓ | 5 | Down + Right |
| 5 | | ✓ | ✓ | | 6 | Down + Left |
| 6 | | ✓ | ✓ | ✓ | 7 | T-bottom |
| 7 | ✓ | | | | 8 | Up only |
| 8 | ✓ | | | ✓ | 9 | Up + Right |
| 9 | ✓ | | ✓ | | 10 | Up + Left |
| 10 | ✓ | | ✓ | ✓ | 11 | T-top |
| 11 | ✓ | ✓ | | | 12 | Vertical |
| 12 | ✓ | ✓ | | ✓ | 13 | T-right |
| 13 | ✓ | ✓ | ✓ | | 14 | T-left |
| 14 | ✓ | ✓ | ✓ | ✓ | 15 | Crossroads |

### File Structure

```
mods/tiles/{id}/
├── definition.json       # Note: hexmanos uses properties.json
├── tile_0.png
├── tile_1.png
└── ... (up to tile_14.png for PATH/BRIDGE)
```

---

## 4. LEVELS

Levels are stored in LDtk-compatible JSON format.

### Level Schema

```typescript
interface LevelData {
  identifier: string;
  pxWid: number;           // Width in pixels
  pxHei: number;           // Height in pixels
  layerInstances: LayerInstance[];
}

interface LayerInstance {
  __identifier: string;    // "Tiles", "Entities"
  __type: string;          // "Tiles", "Entities"
  __gridSize: number;      // 128
  gridTiles?: GridTile[];
  entityInstances?: EntityInstance[];
}

interface GridTile {
  px: [number, number];    // Position in pixels
  t: number | null;        // Variation seed
  src: string;             // Tile asset ID
}

interface EntityInstance {
  __identifier: string;    // "Character" or "Object"
  px: [number, number];    // Position in pixels
  defId: string;           // Character/object ID
}
```

### File Structure

```
mods/levels/{name}.json
```

---

## 5. Editor Features (Status)

### Character/Object Editor

- [x] **Visual States** - full/hurt1/hurt2/critical for characters; new/worn/damaged/broken for objects
- [x] **Add Frame** button (up to 8 max)
- [x] **Duplicate Frame** button
- [x] **Delete Frame** button
- [x] **Move Frame** left/right in timeline
- [ ] **Generate Stickman** for all animations
- [ ] **Import Image** and scale to 128x128
- [x] **Pan/Zoom** - mouse wheel zoom to cursor, right-click/middle-click/space+drag pan
- [x] **Brush sizes** - 1, 2, 4, 8, 16 pixels
- [ ] **Transform tools** - rotate, mirror selection/frame

### Tile Editor

- [x] **Tile Type switching** - TILE, PATH, BRIDGE
- [x] **Terrain Type** - LAND, WATER
- [x] **Random Fill** - fill with random picks from 3 colors
- [x] **Two-Step Path Generation** - separate background and path drawing:
  - **Step 1: Fill All Backgrounds** - fills all 15 variations with terrain colors (no paths)
  - **Step 2: Draw Paths on All 15** - draws paths ON TOP of existing pixels with edge fading
  - Paths are transparent overlays, allowing any terrain underneath
- [x] **Path Width** - configurable center width with edge fading
- [x] **Bridge Association** - select which BRIDGE tile to use for water crossings
- [ ] **Path Guidelines** - show direction indicators on path variations
- [x] **Movement Cost** slider (0=impassable, 1=easy, 3+=difficult)

### Map Editor

- [x] **Layer Support** - Terrain, Paths, Entities
- [x] **Pan/Zoom Canvas** - infinite canvas with zoom-to-cursor
- [x] **Continuous Painting** - Bresenham line interpolation for smooth strokes
- [x] **Path Auto-Connectivity** - automatic variation selection based on neighbors
- [x] **Bridge Auto-Placement** - bridges rendered when paths cross water
- [x] **Bridge Connectivity Matching** - bridge shape matches path shape above
- [x] **Terrain Transitions** - edge blending between different terrain types
- [x] **Entity Placement** - characters and objects
- [x] **Tile/Entity Palettes** - visual selection with thumbnails

---

## 6. Default Colors

### Terrain Fill Colors (Random 3-color fill)
```
#228b22  Forest Green
#2e8b57  Sea Green
#32cd32  Lime Green
```

### Path Colors
```
#8b7355  Medium Brown
#a0826d  Light Brown
#c4a882  Tan
```

### Water Colors
```
#1e90ff  Dodger Blue
#4169e1  Royal Blue
#6495ed  Cornflower Blue
```
