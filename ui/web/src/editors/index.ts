// Legacy editors (work with individual frames)
export { CharacterEditor } from './CharacterEditor';
export { TileEditor } from './TileEditor';
export { WeaponEditor } from './WeaponEditor';
export { MapEditor } from './MapEditor';

// New sprite sheet editors (work directly with atlas PNGs)
export { CharacterSheetEditor } from './CharacterSheetEditor';
export { TileSheetEditor } from './TileSheetEditor';
export { WeaponSheetEditor } from './WeaponSheetEditor';
export { SpriteSheetEditor, type SpriteSheetEditorRef, type SpriteSheetEditorProps } from './SpriteSheetEditor';

// Shared components
export { PixelCanvas, type PixelCanvasRef, type PixelCanvasProps } from './PixelCanvas';
export { ColorPicker, type ColorPickerProps } from './ColorPicker';
export { Toolbar, type ToolbarProps } from './Toolbar';
export * from './types';
