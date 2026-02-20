# ZAP-SQUAD Asset Schema

This document defines the schema for all game assets, ported from hexmanos with simplifications (no visual states).

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

Characters are animated entities with full movement and combat animations.

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
├── {id}_idle_south_0.png
├── {id}_idle_south_1.png
├── {id}_walk_east_0.png
├── {id}_walk_east_1.png
├── {id}_walk_east_2.png
├── {id}_walk_east_3.png
└── ...
```

### File Naming

**New format (no visual states):**
```
{id}_{animation}_{direction}_{frame}.png
```

**Legacy format (for backward compatibility when loading):**
```
{id}_full_{animation}_{direction}_{frame}.png
```

---

## 2. OBJECTS

Objects are simplified entities with only idle/landed animations. Used for projectiles, items, decorations.

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

### Animation States

| State | Required | Loop | Description |
|-------|----------|------|-------------|
| idle | Yes | Yes | Default state (flying projectile, spinning item) |
| landed | No | No | Impact/stopped state (projectile hit, item dropped) |

### File Structure

```
mods/objects/{id}/
├── definition.json
├── {id}_idle_0.png
├── {id}_idle_1.png
├── {id}_landed_0.png
└── ...
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
- Auto-connects based on adjacent paths

#### BRIDGE
- Exactly 15 directional variations
- Always LAND terrain, always passable
- Rendered over water when LAND PATH crosses

### Path Direction Combinations (15 total)

| Index | Up | Down | Left | Right | Description |
|-------|-----|------|------|-------|-------------|
| 0 | | | | ✓ | Right only |
| 1 | | | ✓ | | Left only |
| 2 | | | ✓ | ✓ | Horizontal |
| 3 | | ✓ | | | Down only |
| 4 | | ✓ | | ✓ | Down + Right |
| 5 | | ✓ | ✓ | | Down + Left |
| 6 | | ✓ | ✓ | ✓ | T-bottom |
| 7 | ✓ | | | | Up only |
| 8 | ✓ | | | ✓ | Up + Right |
| 9 | ✓ | | ✓ | | Up + Left |
| 10 | ✓ | | ✓ | ✓ | T-top |
| 11 | ✓ | ✓ | | | Vertical |
| 12 | ✓ | ✓ | | ✓ | T-right |
| 13 | ✓ | ✓ | ✓ | | T-left |
| 14 | ✓ | ✓ | ✓ | ✓ | Crossroads |

### File Structure

```
mods/tiles/{id}/
├── definition.json       # Note: hexmanos uses properties.json
├── tile_0.png
├── tile_1.png
└── ... (up to tile_14.png for PATH/BRIDGE)
```

---

## 4. Editor Features to Port

### Character/Object Editor

- [ ] **Add Frame** button (up to 8 max)
- [ ] **Duplicate Frame** button
- [ ] **Delete Frame** button
- [ ] **Move Frame** left/right in timeline
- [ ] **Generate Stickman** for all animations
- [ ] **Import Image** and scale to 128x128
- [ ] **Pan/Zoom** - mouse wheel zoom to cursor, middle-click/space+drag pan
- [ ] **Brush sizes** - 1, 2, 4, 8, 16 pixels
- [ ] **Transform tools** - rotate, mirror selection/frame

### Tile Editor

- [ ] **Tile Type switching** - TILE, PATH, BRIDGE
- [ ] **Terrain Type** - LAND, WATER
- [ ] **Random Fill** - fill with random picks from 3 colors
- [ ] **Fill All Backgrounds** - apply random fill to all 15 path variations
- [ ] **Path Drawing** with configurable width and fade
- [ ] **Generate All 15 Paths** - auto-generate all direction combinations
- [ ] **Path Guidelines** - show direction indicators on path variations
- [ ] **Movement Cost** slider (0=impassable, 1=easy, 3+=difficult)

---

## 5. Default Colors

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
