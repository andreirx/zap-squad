# Editors (`ui/web/src/editors/`)

## Role: Content Creation Tools
This directory contains the tools used to create content for the game (Levels, Characters, Weapons, Tiles). These are "Editor" mode features, distinct from the main "Game" mode.

## Components
- **CharacterEditor**: For defining character sprites and stats.
- **TileEditor**: For creating tile definitions and pixel art.
- **WeaponEditor**: For defining weapon properties and animations.
- **PixelCanvas**: A shared component for pixel art editing.

## Dependencies
- Uses `storage` to save definitions.
- Uses `hooks` for common functionality.
