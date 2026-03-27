//! Freedom Board WASM — integration layer between React UI and core SparseWorld.
//!
//! This crate implements zap-engine's `Game` trait for the infinite sparse tile
//! canvas. It is a thin adapter: the business logic lives in `zapsquad_core`,
//! and this crate translates between the engine's entity/sprite system and
//! the core's tile coordinate model.
//!
//! # Rendering Model
//!
//! The engine renders entities in screen-pixel coordinates. This crate converts
//! tile coordinates to screen pixels using the camera state received from React:
//!
//! ```text
//! screen_x = (tile_x + 0.5 - camera_x) * zoom
//! screen_y = (tile_y + 0.5 - camera_y) * zoom
//! entity_scale = zoom * SPRITE_SCALE (feathered 160px sprite over 128px tile)
//! ```
//!
//! # Asset Registry
//!
//! `TilePlacement.asset_id` is a compact u16 index. The engine's sprite registry
//! uses string names like `"iarba_0"`. The tile registry (populated once from React
//! via `register_tiles()`) maps u16 → tile name so we can construct sprite lookup
//! keys at render time.
//!
//! # Custom Event Protocol (React -> WASM)
//!
//! All editor commands arrive as `InputEvent::Custom { kind, a, b, c }`:
//!
//! | kind | a            | b            | c              | Description         |
//! |------|--------------|--------------|----------------|---------------------|
//! | 1    | tile_x (i32) | tile_y (i32) | asset_id (u16) | Place tile          |
//! | 2    | tile_x (i32) | tile_y (i32) | layer (u8)     | Erase tile          |
//! | 3    | tool_id      | —            | —              | Set active tool      |
//! | 4    | asset_id     | layer        | variant        | Set active tile      |
//! | 5    | tile_x (i32) | tile_y (i32) | asset_id (u16) | Flood fill          |
//! | 6    | end_x (i32)  | end_y (i32)  | asset_id (u16) | Draw line (from drag_start) |
//! | 7    | end_x (i32)  | end_y (i32)  | asset_id (u16) | Fill rect (from drag_start) |
//! | 8    | end_x (i32)  | end_y (i32)  | layer (u8)     | Erase rect (from drag_start) |
//! | 9    | —            | —            | —              | Undo                |
//! | 10   | —            | —            | —              | Redo                |
//! | 20   | tile_x (i32) | tile_y (i32) | —              | Drag start (store origin) |
//! | 30   | tile_x (i32) | tile_y (i32) | body_idx (u16) | Place character     |
//! | 31   | tile_x (i32) | tile_y (i32) | —              | Remove character    |
//! | 32   | tile_x (i32) | tile_y (i32) | —              | Select character    |
//! | 33   | tile_x (i32) | tile_y (i32) | —              | Move character      |
//! | 100  | camera_x     | camera_y     | zoom (px/tile) | Camera state update |
//! | 101  | width_px     | height_px    | —              | Viewport resize     |
//! | 102  | grid (0/1)   | crosshair    | quadtree (0/1) | Debug flags toggle  |
//!
//! # Game Events (WASM -> React)
//!
//! | kind | a          | b            | c | Description        |
//! |------|------------|--------------|---|--------------------|
//! | 1    | tile_count | chunk_count  | — | World stats update |

use glam::Vec2;
use wasm_bindgen::prelude::*;

use zap_engine::*;

use zapsquad_core::entities::freedom_board::{
    SparseWorld, TileCoord, TilePlacement, VisibleTile, CHUNK_SIZE,
};
use zapsquad_core::entities::{ActorId, AnimationState, CompositeActor, Direction, ScriptId};
use zapsquad_adapters::script_bindings::{ScriptCommand, ScriptEngine, WorldQuery};
use zapsquad_adapters::{RulesScriptEngine, RulesContext, RulesCommand, GameView, CharacterView, TeamView};
use zapsquad_core::entities::game_rules::{
    GameDefinition, GameSession, GamePhase, CharacterInstanceId, TeamId,
    CharacterInstance, validate_game, IssueSeverity,
};
// Alias to avoid collision with zap_engine::GameEvent
use zapsquad_core::entities::game_rules::GameEvent as RulesGameEvent;
use zapsquad_core::use_cases::{apply_damage, calculate_damage, find_path_in_radius, InfiniteNavGrid};
use zapsquad_core::use_cases::freedom_board::{
    connectivity_bitmask_with, draw_line, erase_rect, erase_tile, fill_rect, flood_fill, place_tile,
    query_viewport, stamp_tiles, EditResult,
};

/// Feathered sprite geometry.
///
/// Tile atlases use 160x160 sprites with 16px feathered padding on each side.
/// The logical tile content occupies the inner 128x128 region.
/// When rendering, sprites must be scaled by SPRITE_SCALE so the 128px content
/// maps to exactly `zoom` pixels and the feather extends past the cell boundary.
const TILE_CONTENT_PX: f32 = 128.0;
const SPRITE_PX: f32 = 160.0;
const SPRITE_SCALE: f32 = SPRITE_PX / TILE_CONTENT_PX; // 1.25

/// Custom event kinds: React -> WASM
mod events {
    pub const PLACE_TILE: u32 = 1;
    pub const ERASE_TILE: u32 = 2;
    pub const SET_TOOL: u32 = 3;
    pub const SET_ACTIVE_TILE: u32 = 4;
    pub const FLOOD_FILL: u32 = 5;
    pub const DRAW_LINE: u32 = 6;
    pub const FILL_RECT: u32 = 7;
    pub const ERASE_RECT: u32 = 8;
    pub const UNDO: u32 = 9;
    pub const REDO: u32 = 10;
    pub const DRAG_START: u32 = 20;
    pub const PLACE_CHARACTER: u32 = 30;
    pub const REMOVE_CHARACTER: u32 = 31;
    pub const SELECT_CHARACTER: u32 = 32;
    pub const MOVE_CHARACTER: u32 = 33;
    pub const CAMERA_UPDATE: u32 = 100;
    pub const VIEWPORT_SIZE: u32 = 101;
    /// Debug flags: a = grid (0/1), b = crosshair (0/1), c = quadtree (0/1)
    pub const DEBUG_FLAGS: u32 = 102;
}

/// Game event kinds: WASM -> React
mod game_events {
    pub const WORLD_STATS: u32 = 1;
    /// Session state acknowledgment. a=state_code: 1=def_loaded, 2=playing, 3=stopped, 4=start_failed.
    pub const SESSION_STATE: u32 = 2;
    /// Character selection changed. a=1 (selected), a=0 (deselected).
    /// When a=1: b=actor_id (f32). Detailed info sent via take_selected_character_info().
    pub const CHARACTER_SELECTED: u32 = 3;
}

/// Editor tool modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Tool {
    Pan = 0,
    Draw = 1,
    Erase = 2,
    Fill = 3,
    Line = 4,
    Rect = 5,
    Character = 6,
}

impl Tool {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Tool::Pan,
            1 => Tool::Draw,
            2 => Tool::Erase,
            3 => Tool::Fill,
            4 => Tool::Line,
            5 => Tool::Rect,
            6 => Tool::Character,
            _ => Tool::Pan,
        }
    }
}

/// Tile type classification — determines rendering pass and connectivity behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TileType {
    Tile,   // Base terrain (grass, dirt, ocean)
    Path,   // Walkable roads or water rivers
    Bridge, // Auto-placed under paths crossing water
}

/// Terrain classification — determines bridge auto-placement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerrainType {
    Land,
    Water,
}

/// Per-tile metadata from manifest.json, indexed by asset_id (u16).
/// Populated once at startup via `register_tiles()`.
#[derive(Clone, Debug)]
struct TileAssetInfo {
    /// String name used in sprite lookup: e.g. "iarba", "ocean", "river"
    name: String,
    /// Number of base variations (atlas columns).
    variations: u8,
    /// TILE, PATH, or BRIDGE — determines render layer and connectivity.
    tile_type: TileType,
    /// LAND or WATER — determines bridge auto-placement.
    terrain_type: TerrainType,
    /// For LAND PATH tiles: which bridge asset to render when crossing water.
    /// Stored as the asset_id index (resolved at registration time).
    bridge_asset_id: Option<u16>,
    /// Can characters walk on this tile? false = impassable (water, walls).
    passable: bool,
    /// Movement cost (1-100). Lower = easier. Default 10. Paths typically 5.
    movement_cost: u8,
}

/// Adapter: SparseWorld + tile registry as InfiniteNavGrid for A* pathfinding.
///
/// Layer precedence (top-down, highest layer with a tile determines passability):
///
/// | Priority | Layer | Content    | Effect                                           |
/// |----------|-------|------------|--------------------------------------------------|
/// | 1st      | 3     | Road       | Passable, cost from road tile (typically 5)      |
/// | 2nd      | 2     | Bridge     | Passable, cost from bridge tile — overrides water |
/// | 3rd      | 1     | River      | Impassable (PATH+WATER) — overrides ground below |
/// | 4th      | 0     | Ground     | Passable if tile.passable=true, cost from tile   |
/// | —        | none  | Empty      | Impassable                                       |
///
/// A river on layer 1 makes the cell impassable even if the ground (layer 0) is land.
/// A bridge on layer 2 restores passability over water/rivers.
/// A road on layer 3 is always passable and provides its own cost.
struct SparseWorldNav<'a> {
    world: &'a SparseWorld,
    registry: &'a [TileAssetInfo],
}

impl<'a> SparseWorldNav<'a> {
    /// Look up a tile's asset info from the registry. Returns None for unknown asset IDs.
    fn asset_of(&self, tile: &TilePlacement) -> Option<&TileAssetInfo> {
        self.registry.get(tile.asset_id as usize)
    }
}

impl<'a> InfiniteNavGrid for SparseWorldNav<'a> {
    fn is_walkable(&self, x: i32, y: i32) -> bool {
        let coord = TileCoord::new(x, y);

        // Layer 3: road — always passable if present
        if self.world.get(coord, 3).is_some() {
            return true;
        }

        // Layer 2: bridge — passable, overrides water/river below
        if self.world.get(coord, 2).is_some() {
            return true;
        }

        // Layer 1: river (PATH+WATER) — impassable, overrides ground below
        if let Some(tile) = self.world.get(coord, 1) {
            let passable = self.asset_of(tile).map_or(false, |a| a.passable);
            if !passable {
                return false;
            }
            // Rare: a passable tile on layer 1 (unusual but respect it)
            return true;
        }

        // Layer 0: ground — passable based on tile property
        if let Some(tile) = self.world.get(coord, 0) {
            return self.asset_of(tile).map_or(true, |a| a.passable);
        }

        // No tile at all — impassable
        false
    }

    fn movement_cost(&self, x: i32, y: i32) -> i32 {
        let coord = TileCoord::new(x, y);

        // Cost comes from the highest-priority layer that has a tile.
        // Same precedence as is_walkable: road > bridge > river > ground.

        if let Some(tile) = self.world.get(coord, 3) {
            return self.asset_of(tile).map_or(10, |a| a.movement_cost as i32);
        }
        if let Some(tile) = self.world.get(coord, 2) {
            return self.asset_of(tile).map_or(10, |a| a.movement_cost as i32);
        }
        if let Some(tile) = self.world.get(coord, 1) {
            return self.asset_of(tile).map_or(10, |a| a.movement_cost as i32);
        }
        if let Some(tile) = self.world.get(coord, 0) {
            return self.asset_of(tile).map_or(10, |a| a.movement_cost as i32);
        }

        i32::MAX
    }
}

/// Main game struct implementing zap-engine's Game trait.
///
/// Owns the SparseWorld and translates between the engine's entity system
/// and the core's tile coordinate model.
/// Snapshot of mutable state captured before entering play mode.
/// Restored by stop_game_session() to ensure the board returns cleanly to edit state.
struct PrePlaySnapshot {
    characters: std::collections::HashMap<ActorId, CompositeActor>,
    next_actor_id: u32,
    selected_character: Option<ActorId>,
    movement_targets: std::collections::HashMap<ActorId, glam::Vec2>,
    waypoint_queues: std::collections::HashMap<ActorId, std::collections::VecDeque<glam::Vec2>>,
}

pub struct FreedomBoardGame {
    // ── Core state ──────────────────────────────────────────────────────
    world: SparseWorld,
    undo_stack: Vec<Vec<EditResult>>,
    redo_stack: Vec<Vec<EditResult>>,

    // ── Asset registry (u16 asset_id -> tile name + metadata) ─────────
    tile_registry: Vec<TileAssetInfo>,

    // ── Camera (owned by React, mirrored here for rendering) ─────────
    camera_x: f32,
    camera_y: f32,
    zoom: f32, // pixels per tile on screen
    viewport_width: f32,  // visible game-world width (projection-adjusted)
    viewport_height: f32, // visible game-world height (projection-adjusted)

    // ── Character state ────────────────────────────────────────────────
    /// Characters on the infinite canvas. Separate from tile storage.
    /// Characters use float positions for smooth animation, snapped to
    /// tile grid for placement and collision detection.
    characters: std::collections::HashMap<ActorId, CompositeActor>,
    /// Next actor ID for spawning new characters.
    next_actor_id: u32,
    /// Currently selected character for commands (move, attack).
    selected_character: Option<ActorId>,
    /// Engine entity IDs for character rendering (despawned/respawned like tiles).
    character_entities: Vec<EntityId>,
    /// True when character state changed and entities need rebuild.
    characters_dirty: bool,
    /// Character name registry — maps body_idx (u16) to character ID string.
    /// Populated from manifest.json alongside the tile registry.
    /// Index order matches React's sorted character array.
    character_names: Vec<String>,
    /// Character equipment registry — weapon and throwable assignments per character index.
    /// Parallel to character_names: character_equipment[i] is the equipment for character_names[i].
    character_equipment: Vec<(Option<String>, Option<String>)>, // (weapon_def_id, throwable_def_id)
    /// Active movement targets. Characters with an entry here walk toward
    /// their target each frame instead of teleporting.
    movement_targets: std::collections::HashMap<ActorId, glam::Vec2>,
    /// Queued waypoints from A* pathfinding. When a character arrives at its
    /// current movement_target, the next waypoint is popped from this queue.
    waypoint_queues: std::collections::HashMap<ActorId, std::collections::VecDeque<glam::Vec2>>,

    // ── Scripting state ─────────────────────────────────────────────────
    /// Rhai script engine — compiles and executes .rhai scripts per frame.
    scripts: ScriptEngine,

    // ── Game session orchestrator ────────────────────────────────────────
    /// Loaded game definition. Set via `load_game_definition()` WASM export.
    game_definition: Option<GameDefinition>,
    /// Active game session. Created from game_definition via `start_game()`.
    /// None when in edit mode, Some when playing.
    game_session: Option<GameSession>,
    /// Rhai engine for rules scripts. Separate from legacy AI engine.
    rules_engine: RulesScriptEngine,
    /// Reverse mapping: ActorId → CharacterInstanceId.
    /// Built when characters are spawned during play, cleared on stop.
    actor_to_instance: std::collections::HashMap<ActorId, CharacterInstanceId>,
    /// Snapshot of edit-mode state captured before play. Restored on stop_game().
    /// Ensures repeated start/stop cycles don't pollute the board with session artifacts.
    pre_play_snapshot: Option<PrePlaySnapshot>,
    /// Pending session state events to emit to React. Drained in update() where ctx is available.
    /// Values: 1=def_loaded, 2=playing, 3=stopped, 4=start_failed.
    pending_session_events: Vec<u32>,

    // ── Rendering state ─────────────────────────────────────────────────
    /// Engine entity IDs currently spawned for visible tiles.
    tile_entities: Vec<EntityId>,
    /// SparseWorld generation at last render. Skip re-render if unchanged.
    last_rendered_generation: u64,
    /// True when camera moved and we need to re-render.
    camera_dirty: bool,

    // ── Editor state ────────────────────────────────────────────────────
    active_asset_id: u16,
    active_layer: u8,
    active_variant: u8,
    tool: Tool,
    /// Start coordinate for two-point operations (line, rect).
    /// Set by DRAG_START event, consumed by DRAW_LINE / FILL_RECT / ERASE_RECT.
    drag_start: Option<TileCoord>,

    // ── Debug flags (toggled by React via custom event) ────────────────
    debug_show_grid: bool,
    debug_show_crosshair: bool,
    debug_show_quadtree: bool,

    // ── Stats tracking ──────────────────────────────────────────────────
    /// Last tile_count sent to React, to avoid spamming events.
    last_reported_tile_count: u64,
    /// Last world generation sent to React. Used alongside tile_count to detect
    /// overwrites (same count, different generation).
    last_reported_generation: u64,
    /// Monotonic counter bumped on any character state change (placement, movement,
    /// removal, health). Used by emit_stats_if_changed to trigger auto-save for
    /// character-only edits that don't touch the tile world.
    character_generation: u64,
    last_reported_character_generation: u64,
}

impl FreedomBoardGame {
    pub fn new() -> Self {
        Self {
            world: SparseWorld::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            tile_registry: Vec::new(),

            camera_x: 0.0,
            camera_y: 0.0,
            zoom: 64.0,
            viewport_width: 1920.0,
            viewport_height: 1080.0,

            characters: std::collections::HashMap::new(),
            next_actor_id: 1,
            selected_character: None,
            character_entities: Vec::new(),
            characters_dirty: false,
            character_names: Vec::new(),
            character_equipment: Vec::new(),
            movement_targets: std::collections::HashMap::new(),
            waypoint_queues: std::collections::HashMap::new(),
            scripts: ScriptEngine::new(),

            game_definition: None,
            game_session: None,
            rules_engine: RulesScriptEngine::new(),
            actor_to_instance: std::collections::HashMap::new(),
            pre_play_snapshot: None,
            pending_session_events: Vec::new(),

            tile_entities: Vec::new(),
            last_rendered_generation: u64::MAX, // force initial render
            camera_dirty: true,

            active_asset_id: 0,
            active_layer: 0,
            active_variant: 0,
            tool: Tool::Draw,
            drag_start: None,

            debug_show_grid: true,
            debug_show_crosshair: true,
            debug_show_quadtree: false,

            last_reported_tile_count: u64::MAX,
            last_reported_generation: u64::MAX,
            character_generation: 0,
            last_reported_character_generation: u64::MAX,
        }
    }

    /// Look up the tile name for an asset_id. Returns None if not registered.
    fn tile_name(&self, asset_id: u16) -> Option<&str> {
        self.tile_registry.get(asset_id as usize).map(|t| t.name.as_str())
    }

    /// Look up full tile info for an asset_id.
    fn tile_info(&self, asset_id: u16) -> Option<&TileAssetInfo> {
        self.tile_registry.get(asset_id as usize)
    }

    /// Process a custom event from React.
    /// Push edits to undo stack, capping at 1000 entries to bound memory usage.
    fn push_undo(&mut self, edits: Vec<EditResult>) {
        const MAX_UNDO: usize = 1000;
        self.undo_stack.push(edits);
        if self.undo_stack.len() > MAX_UNDO {
            let excess = self.undo_stack.len() - MAX_UNDO;
            self.undo_stack.drain(0..excess);
        }
        self.redo_stack.clear();
    }

    /// Clear the selected character and write an empty payload to
    /// SELECTED_CHARACTER_INFO so React clears the CharacterPanel.
    fn clear_character_selection(&mut self) {
        self.selected_character = None;
        SELECTED_CHARACTER_INFO.with(|p| {
            *p.borrow_mut() = Some(String::new());
        });
    }

    /// Write the currently selected character's info to SELECTED_CHARACTER_INFO
    /// so the worker can forward it to React for the CharacterPanel.
    fn write_selected_character_info(&self) {
        if let Some(sel_id) = self.selected_character {
            if let Some(actor) = self.characters.get(&sel_id) {
                web_sys::console::log_1(
                    &format!("[freedom-board] writing selected char info: actor={}, body={}", sel_id.0, actor.body_def_id).into(),
                );
                let info = serde_json::json!({
                    "actorId": sel_id.0,
                    "bodyDefId": actor.body_def_id,
                    "scriptName": actor.script_name,
                    "x": actor.position.x,
                    "y": actor.position.y,
                    "health": actor.health,
                    "maxHealth": actor.max_health,
                });
                SELECTED_CHARACTER_INFO.with(|p| {
                    *p.borrow_mut() = Some(info.to_string());
                });
            }
        }
    }

    fn handle_custom_event(&mut self, kind: u32, a: f32, b: f32, c: f32) {
        match kind {
            events::PLACE_TILE => {
                let coord = TileCoord::new(a as i32, b as i32);
                let tile = TilePlacement::new(c as u16, self.active_variant, self.active_layer);
                let edit = place_tile(&mut self.world, coord, tile);
                self.push_undo(vec![edit]);
            }
            events::ERASE_TILE => {
                let coord = TileCoord::new(a as i32, b as i32);
                let layer = c as u8;
                if self.world.get(coord, layer).is_some() {
                    let edit = erase_tile(&mut self.world, coord, layer);
                    self.push_undo(vec![edit]);
                }
            }
            events::FLOOD_FILL => {
                let coord = TileCoord::new(a as i32, b as i32);
                let tile = TilePlacement::new(c as u16, self.active_variant, self.active_layer);
                let edits = flood_fill(&mut self.world, coord, tile, 10_000);
                if !edits.is_empty() {
                    self.push_undo(edits);
                }
            }
            events::DRAW_LINE => {
                if let Some(start) = self.drag_start.take() {
                    let end = TileCoord::new(a as i32, b as i32);
                    let tile = TilePlacement::new(c as u16, self.active_variant, self.active_layer);
                    let edits = draw_line(&mut self.world, start, end, tile);
                    if !edits.is_empty() {
                        self.push_undo(edits);
                    }
                }
            }
            events::FILL_RECT => {
                if let Some(start) = self.drag_start.take() {
                    let end = TileCoord::new(a as i32, b as i32);
                    let tile = TilePlacement::new(c as u16, self.active_variant, self.active_layer);
                    let min = TileCoord::new(start.x.min(end.x), start.y.min(end.y));
                    let max = TileCoord::new(start.x.max(end.x), start.y.max(end.y));
                    let edits = fill_rect(&mut self.world, min, max, tile);
                    if !edits.is_empty() {
                        self.push_undo(edits);
                    }
                }
            }
            events::ERASE_RECT => {
                if let Some(start) = self.drag_start.take() {
                    let end = TileCoord::new(a as i32, b as i32);
                    let layer = c as u8;
                    let min = TileCoord::new(start.x.min(end.x), start.y.min(end.y));
                    let max = TileCoord::new(start.x.max(end.x), start.y.max(end.y));
                    let edits = erase_rect(&mut self.world, min, max, layer);
                    if !edits.is_empty() {
                        self.push_undo(edits);
                    }
                }
            }
            events::UNDO => {
                if let Some(edits) = self.undo_stack.pop() {
                    for edit in edits.iter().rev() {
                        edit.undo(&mut self.world);
                    }
                    self.redo_stack.push(edits);
                }
            }
            events::REDO => {
                if let Some(edits) = self.redo_stack.pop() {
                    for edit in &edits {
                        edit.redo(&mut self.world);
                    }
                    self.undo_stack.push(edits);
                }
            }
            events::DRAG_START => {
                self.drag_start = Some(TileCoord::new(a as i32, b as i32));
            }
            events::PLACE_CHARACTER => {
                // a=tile_x, b=tile_y, c=body_def_index (from character selector)
                // Smart behavior: if a character already occupies this tile,
                // select it instead of stacking another on top.
                let tx = a as i32;
                let ty = b as i32;
                let center_x = tx as f32 + 0.5;
                let center_y = ty as f32 + 0.5;

                let existing = self.characters.iter()
                    .find(|(_, ch)| {
                        (ch.position.x - center_x).abs() < 0.5
                            && (ch.position.y - center_y).abs() < 0.5
                    })
                    .map(|(id, _)| *id);

                if let Some(id) = existing {
                    // Tile occupied — select the existing character
                    self.selected_character = Some(id);
                } else {
                    // Empty tile — place a new character
                    let body_idx = c as usize;
                    let body_id = self.character_names
                        .get(body_idx)
                        .cloned()
                        .unwrap_or_else(|| format!("character_{}", body_idx));
                    let id = ActorId(self.next_actor_id);
                    self.next_actor_id += 1;
                    let mut actor = CompositeActor::new(
                        id,
                        glam::Vec2::new(center_x, center_y),
                        body_id,
                    );
                    // Equip weapon/throwable from character registry
                    if let Some((ref weapon, ref throwable)) = self.character_equipment.get(body_idx) {
                        actor.weapon_def_id = weapon.clone();
                        actor.throwable_def_id = throwable.clone();
                    }
                    self.characters.insert(id, actor);
                    self.selected_character = Some(id); // auto-select newly placed
                    self.character_generation += 1;
                }
                // Write selection info for React CharacterPanel
                self.write_selected_character_info();
                self.characters_dirty = true;
            }
            events::REMOVE_CHARACTER => {
                // If a=0, b=0: remove selected character (keyboard shortcut)
                // Otherwise a=tile_x, b=tile_y: remove character at tile
                let target = if a == 0.0 && b == 0.0 {
                    self.selected_character
                } else {
                    let tx = a as f32 + 0.5;
                    let ty = b as f32 + 0.5;
                    self.characters
                        .iter()
                        .find(|(_, c)| {
                            (c.position.x - tx).abs() < 0.5 && (c.position.y - ty).abs() < 0.5
                        })
                        .map(|(id, _)| *id)
                };
                if let Some(id) = target {
                    self.characters.remove(&id);
                    self.movement_targets.remove(&id);
                    self.waypoint_queues.remove(&id);
                    if self.selected_character == Some(id) {
                        self.clear_character_selection();
                    }
                    self.character_generation += 1;
                    self.characters_dirty = true;
                }
            }
            events::SELECT_CHARACTER => {
                // a=tile_x, b=tile_y — select character at this tile
                let tx = a as f32 + 0.5;
                let ty = b as f32 + 0.5;
                let prev = self.selected_character;
                self.selected_character = self
                    .characters
                    .iter()
                    .find(|(_, c)| {
                        (c.position.x - tx).abs() < 0.5 && (c.position.y - ty).abs() < 0.5
                    })
                    .map(|(id, _)| *id);
                self.characters_dirty = true;

                if self.selected_character != prev {
                    if self.selected_character.is_some() {
                        self.write_selected_character_info();
                    } else {
                        self.clear_character_selection();
                    }
                }
            }
            events::MOVE_CHARACTER => {
                // a=tile_x, b=tile_y — command selected character to walk here.
                // Uses A* pathfinding if ground tiles exist, falls back to straight line.
                if let Some(sel_id) = self.selected_character {
                    let goal_tile = glam::IVec2::new(a as i32, b as i32);

                    if let Some(actor) = self.characters.get(&sel_id) {
                        let start_tile = glam::IVec2::new(
                            actor.position.x.floor() as i32,
                            actor.position.y.floor() as i32,
                        );

                        // Try A* pathfinding on placed ground tiles
                        let nav = SparseWorldNav { world: &self.world, registry: &self.tile_registry };
                        let path = find_path_in_radius(&nav, start_tile, goal_tile, 50);

                        if let Some(waypoints) = path {
                            // Path found — convert tile coords to center positions
                            let mut queue: std::collections::VecDeque<glam::Vec2> = waypoints
                                .iter()
                                .map(|p| glam::Vec2::new(p.x as f32 + 0.5, p.y as f32 + 0.5))
                                .collect();

                            // Set first waypoint as immediate target
                            if let Some(first) = queue.pop_front() {
                                self.movement_targets.insert(sel_id, first);
                                if !queue.is_empty() {
                                    self.waypoint_queues.insert(sel_id, queue);
                                }
                            }
                        } else {
                            // No path — destination is impassable or unreachable. Don't move.
                        }
                    }

                    // Face toward target immediately
                    if let Some(actor) = self.characters.get_mut(&sel_id) {
                        let goal_center = glam::Vec2::new(goal_tile.x as f32 + 0.5, goal_tile.y as f32 + 0.5);
                        let delta = goal_center - actor.position;
                        if let Some(dir) = Direction::from_velocity(delta) {
                            actor.direction = dir;
                        }
                        actor.animation_state = AnimationState::Walk;
                    }
                    self.characters_dirty = true;
                }
            }
            events::SET_TOOL => {
                self.tool = Tool::from_u8(a as u8);
            }
            events::SET_ACTIVE_TILE => {
                self.active_asset_id = a as u16;
                self.active_layer = b as u8;
                self.active_variant = c as u8;
            }
            events::CAMERA_UPDATE => {
                let new_x = a;
                let new_y = b;
                let new_zoom = c;
                if (self.camera_x - new_x).abs() > 0.001
                    || (self.camera_y - new_y).abs() > 0.001
                    || (self.zoom - new_zoom).abs() > 0.01
                {
                    self.camera_x = new_x;
                    self.camera_y = new_y;
                    self.zoom = new_zoom;
                    self.camera_dirty = true;
                }
            }
            events::VIEWPORT_SIZE => {
                let new_w = a;
                let new_h = b;
                if (self.viewport_width - new_w).abs() > 1.0
                    || (self.viewport_height - new_h).abs() > 1.0
                {
                    self.viewport_width = new_w;
                    self.viewport_height = new_h;
                    self.camera_dirty = true;
                }
            }
            events::DEBUG_FLAGS => {
                self.debug_show_grid = a != 0.0;
                self.debug_show_crosshair = b != 0.0;
                self.debug_show_quadtree = c != 0.0;
            }
            _ => {}
        }
    }

    /// Compute the visible tile-coordinate bounds from camera state.
    fn visible_bounds(&self) -> (TileCoord, TileCoord) {
        let margin = 1.0;
        let tiles_wide = self.viewport_width / self.zoom;
        let tiles_tall = self.viewport_height / self.zoom;

        let min_x = (self.camera_x - margin).floor() as i32;
        let min_y = (self.camera_y - margin).floor() as i32;
        let max_x = (self.camera_x + tiles_wide + margin).ceil() as i32;
        let max_y = (self.camera_y + tiles_tall + margin).ceil() as i32;

        (TileCoord::new(min_x, min_y), TileCoord::new(max_x, max_y))
    }

    /// Map storage layer index (0-7) to zap-engine RenderLayer.
    ///
    /// | Storage | RenderLayer  | Semantic          |
    /// |---------|-------------|-------------------|
    /// | 0       | Background  | Ground terrain     |
    /// | 1       | Terrain     | Water/rivers       |
    /// | 2       | Objects     | Bridges            |
    /// | 3       | Foreground  | Paths              |
    /// | 4       | VFX         | Objects/decoration |
    /// | 5-7     | UI          | Characters / HUD   |
    fn storage_to_render_layer(layer: u8) -> RenderLayer {
        match layer {
            0 => RenderLayer::Background,
            1 => RenderLayer::Terrain,
            2 => RenderLayer::Objects,
            3 => RenderLayer::Foreground,
            4 => RenderLayer::VFX,
            _ => RenderLayer::UI,
        }
    }

    /// Despawn all current tile entities, query visible tiles, spawn new entities.
    ///
    /// All layers are rendered in a single pass, sorted by layer (back-to-front).
    /// Path and bridge tiles compute connectivity bitmask for sprite variation.
    /// Move characters with active movement targets toward their destination.
    ///
    /// Called each frame. Characters interpolate smoothly at `MOVE_SPEED` tiles/sec.
    /// When a character arrives within `ARRIVAL_THRESHOLD` of its target, it snaps
    /// to the target position, switches to Idle animation, and the target is removed.
    ///
    /// Uses a fixed dt of 1/60s (the engine runs at requestAnimationFrame cadence).
    /// Execute Rhai scripts for all characters that have assigned script_ids.
    ///
    /// For each character with a script_id, builds a ScriptContext with the actor's
    /// position and a WorldQuery of all other actors, then calls the script's update()
    /// function. Collected ScriptCommands are applied to the actor:
    ///   - MoveTo → inserts into movement_targets (smooth interpolation)
    ///   - SetDirection → directly sets actor.direction
    ///   - SetAnimation → directly sets actor.animation_state
    ///   - SetVelocity → directly sets actor.velocity (overrides movement_targets)
    ///   - Attack → placeholder (logs, does not apply damage yet — see T3)
    ///   - PlaySound → placeholder (no audio system wired yet)
    fn run_scripts(&mut self) {
        const DT: f32 = 1.0 / 60.0;

        // Collect actor IDs that have scripts (can't borrow self mutably during iteration).
        // Prefer script_name (named scripts from IDB) over legacy numeric script_id.
        let scripted: Vec<(ActorId, String)> = self
            .characters
            .values()
            .filter_map(|a| {
                // script_name takes precedence — it's the IDB-stored name
                if let Some(ref name) = a.script_name {
                    return Some((a.id, name.clone()));
                }
                // Legacy fallback: numeric script_id → "script_{id}"
                if let Some(sid) = a.script_id {
                    return Some((a.id, format!("script_{}", sid.0)));
                }
                None
            })
            .collect();

        if scripted.is_empty() {
            return;
        }

        // Build world query from all characters (read-only snapshot)
        let mut query = WorldQuery::new();
        for actor in self.characters.values() {
            query.add_actor(actor.id, actor.position, actor.tag.clone());
        }

        // Run each script and collect commands
        let mut all_commands: Vec<(ActorId, Vec<ScriptCommand>)> = Vec::new();

        for (actor_id, script_name) in &scripted {
            let actor = match self.characters.get(actor_id) {
                Some(a) => a,
                None => continue,
            };

            let ctx = zapsquad_adapters::script_bindings::ScriptContext::new(
                *actor_id,
                actor.position,
                DT,
                query.clone(),
            );

            match self.scripts.run_update_with_context(script_name, ctx) {
                Ok(commands) => {
                    if !commands.is_empty() {
                        all_commands.push((*actor_id, commands));
                    }
                }
                Err(_) => {
                    // Script execution error — silently skip.
                    // Compilation errors are already logged during reload.
                }
            }
        }

        // Apply commands
        let mut kills: Vec<ActorId> = Vec::new();
        for (actor_id, commands) in all_commands {
            for cmd in commands {
                match cmd {
                    ScriptCommand::MoveTo(target) => {
                        // Use the smooth movement system (movement_targets)
                        self.movement_targets.insert(actor_id, target);
                        if let Some(actor) = self.characters.get_mut(&actor_id) {
                            let delta = target - actor.position;
                            if let Some(dir) = Direction::from_velocity(delta) {
                                actor.direction = dir;
                            }
                            actor.animation_state = AnimationState::Walk;
                        }
                    }
                    ScriptCommand::SetDirection(dir) => {
                        if let Some(actor) = self.characters.get_mut(&actor_id) {
                            actor.direction = dir;
                        }
                    }
                    ScriptCommand::SetAnimation(anim) => {
                        if let Some(actor) = self.characters.get_mut(&actor_id) {
                            actor.animation_state = anim;
                        }
                    }
                    ScriptCommand::SetVelocity(vel) => {
                        if let Some(actor) = self.characters.get_mut(&actor_id) {
                            actor.velocity = vel;
                            if vel.length_squared() > 0.1 {
                                actor.update_direction_from_velocity();
                            }
                        }
                    }
                    ScriptCommand::Attack(target_id) => {
                        // Set attacker animation
                        if let Some(actor) = self.characters.get_mut(&actor_id) {
                            actor.animation_state = AnimationState::MeleeAttack;
                        }
                        // Apply damage to target
                        let base = calculate_damage(10); // TODO: get from weapon definition
                        if let Some(target) = self.characters.get_mut(&target_id) {
                            let result = apply_damage(target, base);
                            if result.is_kill {
                                kills.push(target_id);
                            }
                        }
                    }
                    ScriptCommand::PlaySound(_name) => {
                        // TODO: Wire audio system
                    }
                }
            }
            self.characters_dirty = true;
        }

        // Remove killed actors
        for dead_id in &kills {
            self.characters.remove(dead_id);
            self.movement_targets.remove(dead_id);
            self.waypoint_queues.remove(dead_id);
            if self.selected_character == Some(*dead_id) {
                self.clear_character_selection();
            }
            self.character_generation += 1;
            self.characters_dirty = true;
        }
    }

    /// Look up the movement cost of the tile under a world position.
    /// Uses the same layer precedence as SparseWorldNav.
    /// Returns the base cost (default 10) if no tile or unknown asset.
    fn terrain_cost_at(&self, pos: glam::Vec2) -> f32 {
        let coord = TileCoord::new(pos.x.floor() as i32, pos.y.floor() as i32);
        // Same precedence: road > bridge > river > ground
        for layer in [3u8, 2, 1, 0] {
            if let Some(tile) = self.world.get(coord, layer) {
                if let Some(asset) = self.tile_registry.get(tile.asset_id as usize) {
                    return asset.movement_cost as f32;
                }
            }
        }
        10.0
    }

    /// Debug: log the movement cost and passable flag for every tile in the registry.
    /// Call once after manifest is loaded to verify properties made it through the pipeline.
    fn debug_print_tile_costs(&self) {
        for (i, info) in self.tile_registry.iter().enumerate() {
            web_sys::console::log_1(
                &format!(
                    "[tile-debug] #{} {} type={:?} terrain={:?} passable={} cost={}",
                    i, info.name, info.tile_type, info.terrain_type, info.passable, info.movement_cost
                ).into(),
            );
        }
    }

    // ── Game Session Orchestrator ──────────────────────────────────────────
    //
    // Drives the GameSession lifecycle: emit events, execute rules script,
    // apply commands. Only runs when game_session is Some (play mode).

    /// Check pending game session thread-locals. Called at start of update().
    fn check_pending_game_session(&mut self) {
        // Load game definition
        PENDING_GAME_DEF.with(|p| {
            if let Some(json) = p.borrow_mut().take() {
                match serde_json::from_str::<GameDefinition>(&json) {
                    Ok(def) => {
                        web_sys::console::log_1(
                            &format!("[orchestrator] loaded game definition: '{}' mode={:?}", def.name, def.mode).into(),
                        );
                        // Compile the rules script if we have source for it
                        let rules_name = def.rules_script.clone();
                        self.game_definition = Some(def);
                        self.pending_session_events.push(1); // def_loaded
                        if !rules_name.is_empty() && !self.rules_engine.has_script(&rules_name) {
                            web_sys::console::log_1(
                                &format!("[orchestrator] rules script '{}' not yet compiled — load it via reload_scripts()", rules_name).into(),
                            );
                        }
                    }
                    Err(e) => {
                        web_sys::console::error_1(
                            &format!("[orchestrator] failed to parse game definition: {}", e).into(),
                        );
                    }
                }
            }
        });

        // Start game
        let should_start = PENDING_START_GAME.with(|p| {
            let v = *p.borrow();
            *p.borrow_mut() = false;
            v
        });
        if should_start {
            self.start_game_session();
        }

        // Stop game
        let should_stop = PENDING_STOP_GAME.with(|p| {
            let v = *p.borrow();
            *p.borrow_mut() = false;
            v
        });
        if should_stop {
            self.stop_game_session();
        }
    }

    /// Create a GameSession from the loaded definition and begin play.
    /// Runs authoritative validation first — refuses to start if not playable.
    fn start_game_session(&mut self) {
        let def = match &self.game_definition {
            Some(d) => d,
            None => {
                web_sys::console::error_1(&"[orchestrator] cannot start: no game definition loaded".into());
                return;
            }
        };

        // Authoritative validation gate — same validator as wasm-validator crate
        let validation = validate_game(def);
        if !validation.is_playable() {
            for issue in validation.errors() {
                web_sys::console::error_1(
                    &format!("[orchestrator] validation error: {}", issue.message).into(),
                );
            }
            for issue in validation.warnings() {
                web_sys::console::warn_1(
                    &format!("[orchestrator] validation warning: {}", issue.message).into(),
                );
            }
            web_sys::console::error_1(
                &format!("[orchestrator] cannot start: {} errors, {} warnings",
                    validation.errors().len(), validation.warnings().len()).into(),
            );
            self.pending_session_events.push(4); // start_failed
            return;
        }
        // Log warnings even for valid definitions
        for issue in validation.warnings() {
            web_sys::console::warn_1(
                &format!("[orchestrator] warning: {}", issue.message).into(),
            );
        }

        // Snapshot edit-mode state before play mutations begin
        self.pre_play_snapshot = Some(PrePlaySnapshot {
            characters: self.characters.clone(),
            next_actor_id: self.next_actor_id,
            selected_character: self.selected_character,
            movement_targets: self.movement_targets.clone(),
            waypoint_queues: self.waypoint_queues.clone(),
        });

        let mut session = GameSession::from_definition(def);

        // Emit GameStart event
        session.events.push(RulesGameEvent::GameStart);

        // Transition from Setup to Exploration
        session.transition(GamePhase::Exploration);

        web_sys::console::log_1(
            &format!(
                "[orchestrator] game started: '{}' mode={:?} teams={} templates={}",
                def.name, def.mode, session.teams.len(), def.character_templates.len()
            ).into(),
        );

        self.game_session = Some(session);
        self.pending_session_events.push(2); // playing
    }

    /// Stop the active game session and restore pre-play edit-mode state.
    /// All actors spawned during play are removed. Pre-existing actors are restored.
    fn stop_game_session(&mut self) {
        if self.game_session.is_none() {
            return;
        }

        self.game_session = None;
        self.actor_to_instance.clear();

        // Restore edit-mode state from snapshot
        if let Some(snapshot) = self.pre_play_snapshot.take() {
            self.characters = snapshot.characters;
            self.next_actor_id = snapshot.next_actor_id;
            self.selected_character = snapshot.selected_character;
            self.movement_targets = snapshot.movement_targets;
            self.waypoint_queues = snapshot.waypoint_queues;
            self.characters_dirty = true;
            self.character_generation += 1;
            web_sys::console::log_1(&"[orchestrator] game stopped, edit-mode state restored".into());
        } else {
            web_sys::console::warn_1(&"[orchestrator] game stopped but no snapshot to restore".into());
        }
        self.pending_session_events.push(3); // stopped
    }

    /// Run one orchestrator tick. Called from update() when a session is active.
    /// Emits events, executes the rules script, applies commands.
    fn run_orchestrator(&mut self, dt: f32) {
        // Only run if we have an active session
        let session = match &mut self.game_session {
            Some(s) => s,
            None => return,
        };

        // Don't run if game has ended
        if matches!(session.phase, GamePhase::Ended { .. }) {
            return;
        }

        // Emit Tick event for real-time modes
        match session.mode {
            zapsquad_core::entities::game_rules::GameMode::RealTime
            | zapsquad_core::entities::game_rules::GameMode::Tactical => {
                if matches!(session.phase, GamePhase::Exploration) {
                    session.tick(dt);
                    session.events.push(RulesGameEvent::Tick { dt });
                }
            }
            zapsquad_core::entities::game_rules::GameMode::TurnBased => {
                // TurnBased: events emitted on turn transitions, not per-frame
            }
        }

        // Drain events and execute rules script
        let events = session.events.drain();
        if events.is_empty() {
            return;
        }

        // Get the rules script name from the definition
        let rules_script_name = match &self.game_definition {
            Some(def) if !def.rules_script.is_empty() => def.rules_script.clone(),
            _ => return, // no rules script to run
        };

        if !self.rules_engine.has_script(&rules_script_name) {
            return; // script not compiled yet
        }

        // Build GameView snapshot for the rules context
        let game_view = self.build_game_view();

        // Execute rules script for each event
        let mut all_commands: Vec<RulesCommand> = Vec::new();
        for event in &events {
            let (event_name, event_data, event_strings) = self.event_to_dto(event);
            let ctx = RulesContext::new(game_view.clone(), event_name, event_data, event_strings);

            match self.rules_engine.run_on_event(&rules_script_name, ctx) {
                Ok(cmds) => all_commands.extend(cmds),
                Err(e) => {
                    web_sys::console::error_1(
                        &format!("[orchestrator] rules script error: {}", e).into(),
                    );
                }
            }
        }

        // Apply all commands to the session
        for cmd in all_commands {
            self.apply_rules_command(cmd);
        }
    }

    /// Build a GameView DTO from the current session + actor state.
    fn build_game_view(&self) -> GameView {
        let session = match &self.game_session {
            Some(s) => s,
            None => return GameView {
                mode: String::new(), phase: String::new(), clock: 0.0,
                turn_number: 0, active_team_id: None, teams: vec![], characters: vec![],
            },
        };

        GameView {
            mode: format!("{:?}", session.mode),
            phase: format!("{:?}", session.phase),
            clock: session.clock,
            turn_number: session.turn_number,
            active_team_id: session.active_team.map(|t| t.0),
            teams: session.teams.iter().map(|t| TeamView {
                id: t.id.0,
                name: t.name.clone(),
                resources: t.resources.clone(),
                eliminated: t.eliminated,
                unit_count: session.team_characters(t.id).len(),
            }).collect(),
            characters: session.characters.values().map(|c| {
                // Cross-reference actor position
                let (x, y) = c.actor_id
                    .and_then(|aid| self.characters.get(&aid))
                    .map(|actor| (actor.position.x, actor.position.y))
                    .unwrap_or((0.0, 0.0));
                CharacterView {
                    instance_id: c.id.0,
                    team_id: c.team_id.0,
                    x, y,
                    stats: c.stats.clone(),
                    alive: c.alive,
                    tags: vec![], // no tags on CharacterInstance (tags are on templates)
                }
            }).collect(),
        }
    }

    /// Convert a GameEvent to (name, numeric_data, string_data) for RulesContext.
    ///
    /// Event names are always the base type: "StatChanged", "ZoneEntered", "Custom", etc.
    /// String parameters (stat_key, resource_key, zone_id, custom name) go into string_data.
    /// Numeric parameters (dt, damage, team_id, etc.) go into numeric_data.
    fn event_to_dto(&self, event: &RulesGameEvent) -> (String, std::collections::HashMap<String, f64>, std::collections::HashMap<String, String>) {
        let mut data = std::collections::HashMap::<String, f64>::new();
        let mut strings = std::collections::HashMap::<String, String>::new();
        let name = match event {
            RulesGameEvent::GameStart => "GameStart".to_string(),
            RulesGameEvent::Tick { dt } => {
                data.insert("dt".into(), *dt as f64);
                "Tick".to_string()
            }
            RulesGameEvent::TurnStart { team, turn_number } => {
                data.insert("team_id".into(), team.0 as f64);
                data.insert("turn_number".into(), *turn_number as f64);
                "TurnStart".to_string()
            }
            RulesGameEvent::TurnEnd { team, turn_number } => {
                data.insert("team_id".into(), team.0 as f64);
                data.insert("turn_number".into(), *turn_number as f64);
                "TurnEnd".to_string()
            }
            RulesGameEvent::EncounterTriggered { teams } => {
                data.insert("team_a".into(), teams.0 .0 as f64);
                data.insert("team_b".into(), teams.1 .0 as f64);
                "EncounterTriggered".to_string()
            }
            RulesGameEvent::PlanningStart => "PlanningStart".to_string(),
            RulesGameEvent::PlanningEnd => "PlanningEnd".to_string(),
            RulesGameEvent::ResolutionStart => "ResolutionStart".to_string(),
            RulesGameEvent::ResolutionEnd => "ResolutionEnd".to_string(),
            RulesGameEvent::EncounterResolved => "EncounterResolved".to_string(),
            RulesGameEvent::UnitSpawned { character_id, team } => {
                data.insert("character_id".into(), character_id.0 as f64);
                data.insert("team_id".into(), team.0 as f64);
                "UnitSpawned".to_string()
            }
            RulesGameEvent::UnitDamaged { character_id, attacker_id, damage, remaining_hp } => {
                data.insert("character_id".into(), character_id.0 as f64);
                if let Some(a) = attacker_id { data.insert("attacker_id".into(), a.0 as f64); }
                data.insert("damage".into(), *damage as f64);
                data.insert("remaining_hp".into(), *remaining_hp as f64);
                "UnitDamaged".to_string()
            }
            RulesGameEvent::UnitKilled { character_id, killer_id } => {
                data.insert("character_id".into(), character_id.0 as f64);
                if let Some(k) = killer_id { data.insert("killer_id".into(), k.0 as f64); }
                "UnitKilled".to_string()
            }
            RulesGameEvent::StatChanged { character_id, stat_key, old_value, new_value } => {
                data.insert("character_id".into(), character_id.0 as f64);
                data.insert("old_value".into(), *old_value as f64);
                data.insert("new_value".into(), *new_value as f64);
                strings.insert("stat_key".into(), stat_key.clone());
                "StatChanged".to_string()
            }
            RulesGameEvent::ResourceChanged { team, resource_key, old_value, new_value } => {
                data.insert("team_id".into(), team.0 as f64);
                data.insert("old_value".into(), *old_value as f64);
                data.insert("new_value".into(), *new_value as f64);
                strings.insert("resource_key".into(), resource_key.clone());
                "ResourceChanged".to_string()
            }
            RulesGameEvent::WaveStart { wave_number } => {
                data.insert("wave_number".into(), *wave_number as f64);
                "WaveStart".to_string()
            }
            RulesGameEvent::WaveComplete { wave_number } => {
                data.insert("wave_number".into(), *wave_number as f64);
                "WaveComplete".to_string()
            }
            RulesGameEvent::ZoneEntered { character_id, zone_id } => {
                data.insert("character_id".into(), character_id.0 as f64);
                strings.insert("zone_id".into(), zone_id.clone());
                "ZoneEntered".to_string()
            }
            RulesGameEvent::ZoneExited { character_id, zone_id } => {
                data.insert("character_id".into(), character_id.0 as f64);
                strings.insert("zone_id".into(), zone_id.clone());
                "ZoneExited".to_string()
            }
            RulesGameEvent::Custom { name, data: custom_data } => {
                for (k, v) in custom_data {
                    data.insert(k.clone(), *v as f64);
                }
                strings.insert("custom_name".into(), name.clone());
                "Custom".to_string()
            }
        };
        (name, data, strings)
    }

    /// Apply a single RulesCommand to the game session and world state.
    fn apply_rules_command(&mut self, cmd: RulesCommand) {
        match cmd {
            RulesCommand::Log(msg) => {
                web_sys::console::log_1(&format!("[rules] {}", msg).into());
            }
            RulesCommand::SpawnUnit { template_id, team_id, x, y, individual } => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                let def = match &self.game_definition {
                    Some(d) => d,
                    None => return,
                };

                // Find the template
                let template = def.character_templates.iter()
                    .find(|t| t.id.0 == template_id);
                let template = match template {
                    Some(t) => t,
                    None => {
                        web_sys::console::error_1(
                            &format!("[orchestrator] SpawnUnit: template '{}' not found", template_id).into(),
                        );
                        return;
                    }
                };

                // Create domain instance
                let instance_id = session.next_character_id();
                let tid = TeamId(team_id);
                let mut instance = CharacterInstance::from_template(instance_id, tid, template, individual);

                // Create rendering actor
                let actor_id = ActorId(self.next_actor_id);
                self.next_actor_id += 1;
                let mut actor = CompositeActor::new(actor_id, Vec2::new(x, y), &template.body_def_id);
                actor.weapon_def_id = template.weapon_def_id.clone();
                actor.throwable_def_id = template.throwable_def_id.clone();
                actor.tag = format!("team_{}", team_id);
                if let Some(&hp) = template.base_stats.get("hp") {
                    actor.health = hp as i32;
                    actor.max_health = hp as i32;
                }

                // Link domain ↔ rendering
                instance.attach_actor(actor_id);
                self.actor_to_instance.insert(actor_id, instance_id);

                // Store both
                session.add_character(instance);
                self.characters.insert(actor_id, actor);
                self.characters_dirty = true;
                self.character_generation += 1;

                // Emit event
                session.events.push(RulesGameEvent::UnitSpawned {
                    character_id: instance_id,
                    team: tid,
                });

                web_sys::console::log_1(
                    &format!("[orchestrator] spawned '{}' (instance={}, actor={}) at ({}, {})",
                        template.name, instance_id.0, actor_id.0, x, y).into(),
                );
            }
            RulesCommand::KillUnit { character_id } => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                let cid = CharacterInstanceId(character_id);
                if let Some(instance) = session.character_mut(cid) {
                    instance.alive = false;
                    if let Some(actor_id) = instance.actor_id {
                        self.characters.remove(&actor_id);
                        self.movement_targets.remove(&actor_id);
                        self.waypoint_queues.remove(&actor_id);
                        self.actor_to_instance.remove(&actor_id);
                        self.characters_dirty = true;
                        self.character_generation += 1;
                    }
                    session.events.push(RulesGameEvent::UnitKilled {
                        character_id: cid,
                        killer_id: None,
                    });
                }
            }
            RulesCommand::ModifyStat { character_id, stat_key, delta } => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                let cid = CharacterInstanceId(character_id);
                if let Some(instance) = session.character_mut(cid) {
                    let old = instance.stat(&stat_key);
                    let new_val = instance.modify_stat(&stat_key, delta);
                    session.events.push(RulesGameEvent::StatChanged {
                        character_id: cid,
                        stat_key,
                        old_value: old,
                        new_value: new_val,
                    });
                }
            }
            RulesCommand::SetStat { character_id, stat_key, value } => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                let cid = CharacterInstanceId(character_id);
                if let Some(instance) = session.character_mut(cid) {
                    let old = instance.stat(&stat_key);
                    instance.set_stat(&stat_key, value);
                    session.events.push(RulesGameEvent::StatChanged {
                        character_id: cid,
                        stat_key,
                        old_value: old,
                        new_value: value,
                    });
                }
            }
            RulesCommand::ModifyResource { team_id, resource_key, delta } => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                let tid = TeamId(team_id);
                if let Some(team) = session.team_mut(tid) {
                    let old = team.resources.get(&resource_key).copied().unwrap_or(0.0);
                    let entry = team.resources.entry(resource_key.clone()).or_insert(0.0);
                    *entry += delta;
                    let new_val = *entry;
                    session.events.push(RulesGameEvent::ResourceChanged {
                        team: tid,
                        resource_key,
                        old_value: old,
                        new_value: new_val,
                    });
                }
            }
            RulesCommand::SetPhase(phase_str) => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                // Parse phase string to GamePhase
                let phase = match phase_str.as_str() {
                    "Setup" => GamePhase::Setup,
                    "Exploration" => GamePhase::Exploration,
                    "EncounterDecision" => GamePhase::EncounterDecision,
                    "EncounterResolution" => GamePhase::EncounterResolution,
                    _ => {
                        web_sys::console::error_1(
                            &format!("[orchestrator] unknown phase: '{}'", phase_str).into(),
                        );
                        return;
                    }
                };
                session.transition(phase);
            }
            RulesCommand::EndGame { winner_team_id } => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                let winner = winner_team_id.map(TeamId);
                session.transition(GamePhase::Ended { winner });
                web_sys::console::log_1(
                    &format!("[orchestrator] game ended. winner: {:?}", winner).into(),
                );
            }
            RulesCommand::EmitEvent { name, data } => {
                let session = match &mut self.game_session {
                    Some(s) => s,
                    None => return,
                };
                // Convert HashMap<String, f32> → Stats
                let stats_data: std::collections::HashMap<String, f32> = data.into_iter()
                    .map(|(k, v)| (k, v as f32))
                    .collect();
                session.events.push(RulesGameEvent::Custom {
                    name,
                    data: stats_data,
                });
            }
        }
    }

    fn update_character_movement(&mut self) {
        /// Base movement speed at cost=1 (tiles per second).
        const BASE_SPEED: f32 = 4.0;
        /// Reference cost that produces BASE_SPEED. Speed scales as BASE_COST / actual_cost.
        const BASE_COST: f32 = 1.0;
        const ARRIVAL_THRESHOLD: f32 = 0.05;
        const DT: f32 = 1.0 / 60.0;

        if self.movement_targets.is_empty() {
            return;
        }

        let mut arrived: Vec<ActorId> = Vec::new();

        // Pre-read terrain costs before mutable character borrows (avoids borrow conflict)
        let costs: Vec<(ActorId, f32)> = self.movement_targets.keys()
            .filter_map(|id| {
                self.characters.get(id).map(|a| (*id, self.terrain_cost_at(a.position)))
            })
            .collect();
        let cost_map: std::collections::HashMap<ActorId, f32> = costs.into_iter().collect();

        for (id, target) in &self.movement_targets {
            if let Some(actor) = self.characters.get_mut(id) {
                let delta = *target - actor.position;
                let dist = delta.length();

                if dist < ARRIVAL_THRESHOLD {
                    actor.position = *target;
                    actor.animation_state = AnimationState::Idle;
                    actor.animation_frame = 0;
                    actor.animation_timer = 0.0;
                    arrived.push(*id);
                } else {
                    // Scale speed by terrain difficulty: cost 5 → 2x speed, cost 20 → 0.5x speed
                    let cost = cost_map.get(id).copied().unwrap_or(BASE_COST);
                    let speed = BASE_SPEED * (BASE_COST / cost.max(1.0));
                    let step_dist = speed * DT;

                    if step_dist >= dist {
                        actor.position = *target;
                        actor.animation_state = AnimationState::Idle;
                        actor.animation_frame = 0;
                        actor.animation_timer = 0.0;
                        arrived.push(*id);
                    } else {
                        let direction = delta / dist;
                        actor.position += direction * step_dist;
                        actor.animation_state = AnimationState::Walk;
                        if let Some(dir) = Direction::from_velocity(delta) {
                            actor.direction = dir;
                        }
                    }
                    self.characters_dirty = true;
                }
            } else {
                arrived.push(*id);
            }
        }

        for id in arrived {
            // Check if there are more waypoints in the queue
            let next_waypoint = self.waypoint_queues.get_mut(&id).and_then(|q| q.pop_front());
            if let Some(next) = next_waypoint {
                // More waypoints — set next as movement target, update direction
                self.movement_targets.insert(id, next);
                if let Some(actor) = self.characters.get_mut(&id) {
                    let delta = next - actor.position;
                    if let Some(dir) = Direction::from_velocity(delta) {
                        actor.direction = dir;
                    }
                    actor.animation_state = AnimationState::Walk;
                }
                // Clean up empty queue
                if self.waypoint_queues.get(&id).map_or(false, |q| q.is_empty()) {
                    self.waypoint_queues.remove(&id);
                }
            } else {
                // No more waypoints — stop
                self.movement_targets.remove(&id);
                self.waypoint_queues.remove(&id);
            }
            self.characters_dirty = true;
        }
    }

    /// Advance animation timers and frame counters for all characters.
    ///
    /// Walk animations use a faster frame rate than idle to give responsive
    /// visual feedback during movement.
    fn update_animation_frames(&mut self) {
        const DT: f32 = 1.0 / 60.0;
        const WALK_FRAME_DURATION: f32 = 0.12;
        const IDLE_FRAME_DURATION: f32 = 0.25;

        if self.characters.is_empty() {
            return;
        }

        for actor in self.characters.values_mut() {
            let duration = match actor.animation_state {
                AnimationState::Walk => WALK_FRAME_DURATION,
                AnimationState::Idle => IDLE_FRAME_DURATION,
                AnimationState::MeleeAttack => 0.08,
                AnimationState::ThrowAttack => 0.10,
            };

            actor.animation_timer += DT;
            if actor.animation_timer >= duration {
                actor.animation_timer -= duration;
                actor.animation_frame = (actor.animation_frame + 1) % 4;
                self.characters_dirty = true;
            }
        }
    }

    /// Bridge auto-placement checks the water layer underneath land paths.
    ///
    /// TODO(perf): Entity pooling — reuse EntityIds, only update positions on camera pan.
    /// Current approach: full despawn/respawn. Acceptable for <10K visible tiles.
    fn rebuild_visible_entities(&mut self, ctx: &mut EngineContext) {
        // Despawn old entities
        for entity_id in self.tile_entities.drain(..) {
            ctx.despawn(entity_id);
        }

        let (vp_min, vp_max) = self.visible_bounds();
        let mut visible: Vec<VisibleTile> = query_viewport(&self.world, vp_min, vp_max);
        let scale = Vec2::splat(self.zoom * SPRITE_SCALE);

        // Sort by layer for correct back-to-front compositing order
        visible.sort_by_key(|vt| vt.placement.layer);

        for vt in &visible {
            // Extract owned tile metadata so the immutable borrow of `self` drops
            // before we mutate `self.tile_entities`.
            let (tile_name, tile_type, terrain_type, bridge_asset_id) =
                match self.tile_info(vt.placement.asset_id) {
                    Some(i) => (i.name.clone(), i.tile_type, i.terrain_type, i.bridge_asset_id),
                    None => continue,
                };

            let layer = vt.placement.layer;
            let coord = TileCoord::new(vt.x, vt.y);
            let screen = self.tile_to_screen(vt.x as f32 + 0.5, vt.y as f32 + 0.5);

            // Determine sprite variation based on tile type:
            //   PATH/BRIDGE: connectivity bitmask
            //     - LAND paths: connect to ANY other land path (cross-type connectivity)
            //     - WATER paths: connect only to same asset_id (no cross-type)
            //   TILE: stored variant from TilePlacement
            let variation = if tile_type == TileType::Path || tile_type == TileType::Bridge {
                let registry = &self.tile_registry;
                let is_land = terrain_type == TerrainType::Land;
                let bits = connectivity_bitmask_with(
                    &self.world,
                    coord,
                    layer,
                    |center, neighbor| {
                        if is_land {
                            // Land paths connect to any other land path
                            let neighbor_info = registry.get(neighbor.asset_id as usize);
                            neighbor_info.map_or(false, |ni| {
                                (ni.tile_type == TileType::Path || ni.tile_type == TileType::Bridge)
                                    && ni.terrain_type == TerrainType::Land
                            })
                        } else {
                            // Water paths: same asset only
                            center.asset_id == neighbor.asset_id
                        }
                    },
                );
                if bits == 0 { 0 } else { bits - 1 }
            } else {
                vt.placement.variant
            };

            let render_layer = Self::storage_to_render_layer(layer);

            // Bridge auto-placement: LAND PATH over water → spawn bridge entity
            // on the bridge render layer (Objects) before spawning the path itself.
            if tile_type == TileType::Path && terrain_type == TerrainType::Land {
                if let Some(bridge_aid) = bridge_asset_id {
                    if self.check_impassable_underneath(coord) {
                        let bridge_name = self.tile_info(bridge_aid).map(|bi| bi.name.clone());
                        if let Some(bname) = bridge_name {
                            let bridge_key = format!("{}_{}", bname, variation);

                            let bid = ctx.next_id();
                            let mut bridge_entity = Entity::new(bid)
                                .with_pos(screen)
                                .with_scale(scale)
                                .with_layer(Self::storage_to_render_layer(2)); // bridge layer

                            if let Some(sprite) = ctx.sprite(&bridge_key) {
                                bridge_entity.sprite = Some(sprite);
                            }

                            ctx.scene.spawn(bridge_entity);
                            self.tile_entities.push(bid);
                        }
                    }
                }
            }

            // Spawn the tile entity
            let id = ctx.next_id();
            let mut entity = Entity::new(id)
                .with_pos(screen)
                .with_scale(scale)
                .with_layer(render_layer);

            let sprite_key = format!("{}_{}", tile_name, variation);
            if let Some(sprite) = ctx.sprite(&sprite_key) {
                entity.sprite = Some(sprite);
            }

            ctx.scene.spawn(entity);
            self.tile_entities.push(id);
        }
    }

    /// Check if there's water terrain underneath a given coordinate.
    ///
    /// With multi-layer storage, checks layers 0 (ground) and 1 (water)
    /// at the same position for any tile with terrainType=WATER.
    /// Check if there is an impassable tile underneath this coordinate
    /// (on layers 0-1). Used to decide whether a land path needs a bridge.
    ///
    /// Triggers on: water terrain (ocean, rivers), impassable paths (fences/gard).
    fn check_impassable_underneath(&self, coord: TileCoord) -> bool {
        for layer in 0..2u8 {
            if let Some(tile) = self.world.get(coord, layer) {
                if let Some(info) = self.tile_info(tile.asset_id) {
                    if !info.passable {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Rebuild character entities as sprite-based entities on the UI layer.
    ///
    /// Uses the same spawn/despawn pattern as tiles. Each character is an
    /// Entity with a sprite looked up from the engine's asset registry using
    /// the character's body_def_id, animation state, direction, and frame:
    ///   sprite key = "{body_def_id}/{anim}_{direction}/{frame}"
    ///
    /// Characters render at scale = zoom (128px sprites fill one tile).
    /// No feathering — character atlases are 128x128, not 160x160.
    ///
    /// Selection ring and health bar remain as vector overlays on top.
    fn rebuild_character_entities(&mut self, ctx: &mut EngineContext) {
        // Despawn old character entities
        for eid in self.character_entities.drain(..) {
            ctx.despawn(eid);
        }

        let (vp_min, vp_max) = self.visible_bounds();
        let scale = Vec2::splat(self.zoom); // 128px sprites, no feathering

        for (id, actor) in &self.characters {
            // Frustum cull — skip characters outside viewport
            let tx = actor.position.x.floor() as i32;
            let ty = actor.position.y.floor() as i32;
            if tx < vp_min.x - 1 || tx > vp_max.x + 1 || ty < vp_min.y - 1 || ty > vp_max.y + 1
            {
                continue;
            }

            let screen = self.tile_to_screen(actor.position.x, actor.position.y);
            let is_selected = self.selected_character == Some(*id);

            // Build sprite key: "{body_def_id}/{anim}_{direction}/{frame}"
            let dir_name = match actor.direction {
                Direction::North => "north",
                Direction::East => "east",
                Direction::South => "south",
                Direction::West => "west",
            };
            let anim_name = match actor.animation_state {
                AnimationState::Idle => "idle",
                AnimationState::Walk => "walk",
                AnimationState::MeleeAttack => "melee_attack",
                AnimationState::ThrowAttack => "throw_attack",
            };
            let frame = actor.animation_frame;
            let sprite_key = format!("{}/{}_{}/{}", actor.body_def_id, anim_name, dir_name, frame);

            // Spawn character entity with sprite
            let eid = ctx.next_id();
            let mut entity = Entity::new(eid)
                .with_pos(screen)
                .with_scale(scale)
                .with_layer(RenderLayer::UI);

            // Sprite fallback chain:
            // 1. Exact key: {body}/{anim}_{dir}/{frame}
            // 2. Frame 0 of same anim+dir
            // 3. Idle of same dir, frame 0
            // 4. Same anim, south direction, frame 0
            // 5. Idle south, frame 0 (guaranteed minimum by schema)
            let sprite = ctx.sprite(&sprite_key)
                .or_else(|| {
                    let k = format!("{}/{}_{}/0", actor.body_def_id, anim_name, dir_name);
                    ctx.sprite(&k)
                })
                .or_else(|| {
                    let k = format!("{}/idle_{}/0", actor.body_def_id, dir_name);
                    ctx.sprite(&k)
                })
                .or_else(|| {
                    let k = format!("{}/{}_{}/0", actor.body_def_id, anim_name, "south");
                    ctx.sprite(&k)
                })
                .or_else(|| {
                    let k = format!("{}/idle_south/0", actor.body_def_id);
                    ctx.sprite(&k)
                });
            if let Some(s) = sprite {
                entity.sprite = Some(s);
            }

            ctx.scene.spawn(entity);
            self.character_entities.push(eid);

            // Selection ring (vector overlay on top of sprite)
            if is_selected {
                let half = self.zoom / 2.0;
                let ring_color = VectorColor::new(1.0, 1.0, 0.3, 0.7);
                ctx.vectors.stroke_rect(
                    Vec2::new(screen.x - half - 2.0, screen.y - half - 2.0),
                    self.zoom + 4.0,
                    self.zoom + 4.0,
                    2.0,
                    ring_color,
                );
            }

            // Health bar (vector overlay, only if damaged)
            if actor.health < actor.max_health {
                let half = self.zoom / 2.0;
                let bar_width = self.zoom * 0.8;
                let bar_height = self.zoom * 0.08;
                let bar_x = screen.x - bar_width / 2.0;
                let bar_y = screen.y - half - bar_height - 3.0;
                let hp_pct = actor.health as f32 / actor.max_health as f32;

                ctx.vectors.fill_rect(
                    Vec2::new(bar_x, bar_y),
                    bar_width,
                    bar_height,
                    VectorColor::new(0.2, 0.2, 0.2, 0.8),
                );
                let hp_color = if hp_pct > 0.5 {
                    VectorColor::new(0.2, 0.8, 0.2, 0.9)
                } else if hp_pct > 0.25 {
                    VectorColor::new(0.8, 0.6, 0.1, 0.9)
                } else {
                    VectorColor::new(0.9, 0.1, 0.1, 0.9)
                };
                ctx.vectors.fill_rect(
                    Vec2::new(bar_x, bar_y),
                    bar_width * hp_pct,
                    bar_height,
                    hp_color,
                );
            }
        }
    }

    /// Emit world stats to React if anything changed (tiles, characters, or both).
    ///
    /// Checks tile count, world generation, AND character generation. This ensures
    /// that any edit — tile placement, character placement, combat kill — triggers
    /// the React-side auto-save debounce.
    fn emit_stats_if_changed(&mut self, ctx: &mut EngineContext) {
        let tc = self.world.tile_count();
        let gen = self.world.generation();
        let cgen = self.character_generation;
        if tc != self.last_reported_tile_count
            || gen != self.last_reported_generation
            || cgen != self.last_reported_character_generation
        {
            self.last_reported_tile_count = tc;
            self.last_reported_generation = gen;
            self.last_reported_character_generation = cgen;
            ctx.events.push(GameEvent {
                kind: game_events::WORLD_STATS as f32,
                a: tc as f32,
                b: self.world.chunk_count() as f32,
                c: 0.0,
            });
        }
    }

    // ── World serialization / deserialization ─────────────────────────────
    //
    // These methods convert between the runtime SparseWorld (compact u16 asset_ids)
    // and the portable JSON format stored in IndexedDB (string-based identifiers).
    //
    // TECH DEBT: The `uuid` field currently contains the tile name (e.g. "iarba"),
    // not a true UUID4. This is correct for seed assets with stable, deterministic
    // names. When user-created assets arrive (Phase 4 of the persistence ADR),
    // the UUID intern table refactor will replace name strings with proper UUIDs.

    /// Serialize the entire world state to a JSON string.
    ///
    /// Resolves u16 asset_ids to name strings via tile_registry.
    /// Tiles with unresolvable asset_ids are skipped (logged as warning).
    /// Output is sorted by (x, y, layer) for deterministic serialization.
    fn serialize_world(&self) -> String {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct WorldExport {
            version: u32,
            tiles: Vec<TileExport>,
            characters: Vec<CharExport>,
            camera: CameraExport,
        }

        #[derive(serde::Serialize)]
        struct TileExport {
            x: i32,
            y: i32,
            uuid: String,
            variant: u8,
            layer: u8,
            flags: u8,
        }

        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CharExport {
            x: f32,
            y: f32,
            body_def_id: String,
            direction: String,
            health: i32,
            max_health: i32,
            #[serde(skip_serializing_if = "Option::is_none")]
            script_name: Option<String>,
        }

        #[derive(serde::Serialize)]
        struct CameraExport {
            x: f32,
            y: f32,
            zoom: f32,
        }

        // Walk all tiles, resolve asset_id → name
        let mut tiles = Vec::new();
        let mut skipped = 0u32;

        for (coord, placement) in self.world.iter_all() {
            if let Some(name) = self.tile_name(placement.asset_id) {
                tiles.push(TileExport {
                    x: coord.x,
                    y: coord.y,
                    uuid: name.to_string(),
                    variant: placement.variant,
                    layer: placement.layer,
                    flags: placement.flags,
                });
            } else {
                skipped += 1;
            }
        }

        if skipped > 0 {
            web_sys::console::warn_1(
                &format!(
                    "[freedom-board] export: skipped {} tiles with unresolvable asset_ids",
                    skipped
                )
                .into(),
            );
        }

        // Deterministic output: sort by (x, y, layer)
        tiles.sort_by(|a, b| a.x.cmp(&b.x).then(a.y.cmp(&b.y)).then(a.layer.cmp(&b.layer)));

        // Serialize characters
        let characters: Vec<CharExport> = self
            .characters
            .values()
            .map(|actor| {
                let dir_str = match actor.direction {
                    Direction::North => "north",
                    Direction::East => "east",
                    Direction::South => "south",
                    Direction::West => "west",
                };
                CharExport {
                    x: actor.position.x,
                    y: actor.position.y,
                    body_def_id: actor.body_def_id.clone(),
                    direction: dir_str.to_string(),
                    health: actor.health,
                    max_health: actor.max_health,
                    script_name: actor.script_name.clone(),
                }
            })
            .collect();

        let export = WorldExport {
            version: 1,
            tiles,
            characters,
            camera: CameraExport {
                x: self.camera_x,
                y: self.camera_y,
                zoom: self.zoom,
            },
        };

        web_sys::console::log_1(
            &format!(
                "[freedom-board] serialize_world: {} tiles, {} characters",
                export.tiles.len(),
                export.characters.len()
            )
            .into(),
        );

        serde_json::to_string(&export).unwrap_or_else(|e| {
            web_sys::console::error_1(
                &format!("[freedom-board] serialization error: {}", e).into(),
            );
            "{}".to_string()
        })
    }

    /// Replace the current world state from a JSON string.
    ///
    /// Clears all tiles, undo/redo stacks, and characters before importing.
    /// Resolves name strings back to u16 asset_ids via tile_registry.
    /// Tiles with unresolvable names are skipped (logged as warning).
    fn import_world_from_json(&mut self, json: &str) {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct WorldImport {
            version: u32,
            tiles: Vec<TileImport>,
            #[serde(default)]
            characters: Vec<CharImport>,
            #[serde(default)]
            camera: Option<CameraImport>,
        }

        #[derive(serde::Deserialize)]
        struct TileImport {
            x: i32,
            y: i32,
            uuid: String,
            variant: u8,
            layer: u8,
            #[serde(default)]
            flags: u8,
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CharImport {
            x: f32,
            y: f32,
            body_def_id: String,
            direction: String,
            health: i32,
            max_health: i32,
            script_name: Option<String>,
        }

        #[derive(serde::Deserialize)]
        struct CameraImport {
            x: f32,
            y: f32,
            zoom: f32,
        }

        let import: WorldImport = match serde_json::from_str(json) {
            Ok(data) => data,
            Err(e) => {
                web_sys::console::error_1(
                    &format!("[freedom-board] import parse error: {}", e).into(),
                );
                return;
            }
        };

        if import.version != 1 {
            web_sys::console::error_1(
                &format!(
                    "[freedom-board] unsupported world version: {} (expected 1)",
                    import.version
                )
                .into(),
            );
            return;
        }

        // Clear current state — imported state becomes the new baseline.
        // Must happen before building the tile registry borrow below.
        self.world.clear();
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.characters.clear();
        self.movement_targets.clear();
        self.waypoint_queues.clear();
        self.clear_character_selection();

        // Build reverse lookup: tile name → u16 asset_id
        let name_to_id: std::collections::HashMap<&str, u16> = self
            .tile_registry
            .iter()
            .enumerate()
            .map(|(i, info)| (info.name.as_str(), i as u16))
            .collect();

        // Import tiles
        let mut imported = 0u32;
        let mut skipped = 0u32;
        for tile in &import.tiles {
            if let Some(&asset_id) = name_to_id.get(tile.uuid.as_str()) {
                let coord = TileCoord::new(tile.x, tile.y);
                let placement =
                    TilePlacement::new(asset_id, tile.variant, tile.layer).with_flags(tile.flags);
                self.world.set(coord, placement);
                imported += 1;
            } else {
                skipped += 1;
            }
        }

        // Import characters
        for ch in &import.characters {
            let direction = match ch.direction.as_str() {
                "north" => Direction::North,
                "east" => Direction::East,
                "west" => Direction::West,
                _ => Direction::South,
            };
            let id = ActorId(self.next_actor_id);
            self.next_actor_id += 1;
            let mut actor = CompositeActor::new(
                id,
                glam::Vec2::new(ch.x, ch.y),
                ch.body_def_id.clone(),
            );
            actor.direction = direction;
            actor.health = ch.health;
            actor.max_health = ch.max_health;
            actor.script_name = ch.script_name.clone();
            self.characters.insert(id, actor);
        }
        self.character_generation += 1;

        // Restore camera if provided
        if let Some(cam) = import.camera {
            self.camera_x = cam.x;
            self.camera_y = cam.y;
            self.zoom = cam.zoom;
        }

        self.camera_dirty = true;
        self.characters_dirty = true;

        web_sys::console::log_1(
            &format!(
                "[freedom-board] imported world: {} tiles ({} skipped), {} characters",
                imported, skipped, import.characters.len()
            )
            .into(),
        );
    }

    // ── Vector overlay rendering ──────────────────────────────────────────
    //
    // Grid, origin crosshair, and quadtree debug rectangles are drawn via
    // the engine's vector system (Lyon tessellation → triangle buffer).
    // Vectors are cleared each frame, so these must be redrawn every update().
    //
    // All coordinates are in game-world space. The engine's projection
    // (aspect-preserving orthographic) maps them to screen pixels.

    /// Convert tile coordinate to game-world position (top-left corner of tile).
    #[inline]
    fn tile_to_screen(&self, tx: f32, ty: f32) -> Vec2 {
        Vec2::new(
            (tx - self.camera_x) * self.zoom,
            (ty - self.camera_y) * self.zoom,
        )
    }

    /// Draw tile grid lines within the visible area.
    ///
    /// Only drawn when zoom >= 16 game-world-pixels per tile (same threshold
    /// as the old CSS overlay). At lower zoom, grid lines are too dense to
    /// be useful.
    fn draw_grid(&self, ctx: &mut EngineContext) {
        if self.zoom < 16.0 {
            return;
        }

        let color = VectorColor::new(1.0, 1.0, 1.0, 0.06);
        let line_width = 1.0;

        let tiles_wide = self.viewport_width / self.zoom;
        let tiles_tall = self.viewport_height / self.zoom;

        let min_tx = self.camera_x.floor() as i32;
        let max_tx = (self.camera_x + tiles_wide).ceil() as i32 + 1;
        let min_ty = self.camera_y.floor() as i32;
        let max_ty = (self.camera_y + tiles_tall).ceil() as i32 + 1;

        // Vertical lines (at each tile x boundary)
        for tx in min_tx..=max_tx {
            let screen_x = (tx as f32 - self.camera_x) * self.zoom;
            ctx.vectors.stroke_polyline(
                &[
                    Vec2::new(screen_x, 0.0),
                    Vec2::new(screen_x, self.viewport_height),
                ],
                line_width,
                color,
            );
        }

        // Horizontal lines (at each tile y boundary)
        for ty in min_ty..=max_ty {
            let screen_y = (ty as f32 - self.camera_y) * self.zoom;
            ctx.vectors.stroke_polyline(
                &[
                    Vec2::new(0.0, screen_y),
                    Vec2::new(self.viewport_width, screen_y),
                ],
                line_width,
                color,
            );
        }
    }

    /// Draw origin crosshair (red lines at tile x=0 and y=0).
    fn draw_origin_crosshair(&self, ctx: &mut EngineContext) {
        let color = VectorColor::new(0.914, 0.271, 0.376, 0.3); // #e94560 at 30% alpha
        let line_width = 1.0;

        // Vertical line at x=0
        let x0 = -self.camera_x * self.zoom;
        ctx.vectors.stroke_polyline(
            &[Vec2::new(x0, 0.0), Vec2::new(x0, self.viewport_height)],
            line_width,
            color,
        );

        // Horizontal line at y=0
        let y0 = -self.camera_y * self.zoom;
        ctx.vectors.stroke_polyline(
            &[Vec2::new(0.0, y0), Vec2::new(self.viewport_width, y0)],
            line_width,
            color,
        );
    }

    /// Draw quadtree node boundaries for debug visualization.
    ///
    /// Colors encode depth: deeper nodes are more saturated.
    /// Leaf nodes (containing a single chunk) get a different color from branches.
    fn draw_quadtree_debug(&self, ctx: &mut EngineContext) {
        let debug_nodes = self.world.debug_quadtree_nodes();
        if debug_nodes.is_empty() {
            return;
        }

        for node in &debug_nodes {
            // Skip empty nodes
            if node.chunk_count == 0 {
                continue;
            }

            // Convert chunk bounds to game-world coordinates.
            // ChunkAABB is in chunk coords; multiply by CHUNK_SIZE for tile coords.
            let tile_min_x = node.bounds.min_x * CHUNK_SIZE;
            let tile_min_y = node.bounds.min_y * CHUNK_SIZE;
            let tile_max_x = node.bounds.max_x * CHUNK_SIZE;
            let tile_max_y = node.bounds.max_y * CHUNK_SIZE;

            let screen_min = self.tile_to_screen(tile_min_x as f32, tile_min_y as f32);
            let screen_max = self.tile_to_screen(tile_max_x as f32, tile_max_y as f32);

            let w = screen_max.x - screen_min.x;
            let h = screen_max.y - screen_min.y;

            // Skip if entirely off-screen
            if screen_max.x < 0.0
                || screen_max.y < 0.0
                || screen_min.x > self.viewport_width
                || screen_min.y > self.viewport_height
            {
                continue;
            }

            // Color by type: cyan for leaves, yellow for branches.
            // Alpha fades with depth to avoid visual noise.
            let alpha = (0.4 - node.depth as f32 * 0.05).max(0.08);
            let line_width = if node.is_leaf { 1.0 } else { 2.0 };
            let color = if node.is_leaf {
                VectorColor::new(0.0, 0.8, 1.0, alpha) // cyan
            } else {
                VectorColor::new(1.0, 0.8, 0.0, alpha) // yellow
            };

            ctx.vectors.stroke_rect(screen_min, w, h, line_width, color);
        }
    }
}

impl Default for FreedomBoardGame {
    fn default() -> Self {
        Self::new()
    }
}

impl Game for FreedomBoardGame {
    fn config(&self) -> GameConfig {
        GameConfig {
            world_width: 1920.0,
            world_height: 1080.0,
            fixed_dt: 1.0 / 60.0,
            max_entities: 50_000,
            max_instances: 50_000,
            max_layer_batches: 64,
            ..Default::default()
        }
    }

    fn init(&mut self, _ctx: &mut EngineContext) {
        // Check for pending tile registry (set before init via register_tiles)
        PENDING_TILE_REGISTRY.with(|p| {
            if let Some(registry) = p.borrow_mut().take() {
                self.tile_registry = registry;
                web_sys::console::log_1(
                    &format!("[freedom-board] tile registry: {} tiles", self.tile_registry.len()).into(),
                );
            }
        });
        web_sys::console::log_1(&"[freedom-board] initialized".into());
    }

    fn update(&mut self, ctx: &mut EngineContext, input: &InputQueue) {
        // 0. Check for pending tile registry updates
        PENDING_TILE_REGISTRY.with(|p| {
            if let Some(registry) = p.borrow_mut().take() {
                web_sys::console::log_1(
                    &format!("[freedom-board] tile registry updated: {} tiles", registry.len()).into(),
                );
                self.tile_registry = registry;
                self.debug_print_tile_costs();
                self.camera_dirty = true; // force re-render with new sprites
            }
        });

        // 0b. Check for pending character name registry
        PENDING_CHARACTER_NAMES.with(|p| {
            if let Some(names) = p.borrow_mut().take() {
                web_sys::console::log_1(
                    &format!("[freedom-board] character names updated: {} entries", names.len()).into(),
                );
                self.character_names = names;
                self.characters_dirty = true;
            }
        });

        PENDING_CHARACTER_EQUIPMENT.with(|p| {
            if let Some(equipment) = p.borrow_mut().take() {
                self.character_equipment = equipment;
            }
        });

        // 0c. Check for pending stamp (map import)
        PENDING_STAMP.with(|p| {
            if let Some((origin, tiles)) = p.borrow_mut().take() {
                let count = tiles.len();
                let edits = stamp_tiles(&mut self.world, origin, &tiles);
                if !edits.is_empty() {
                    web_sys::console::log_1(
                        &format!(
                            "[freedom-board] stamped {} tiles at ({}, {})",
                            count, origin.x, origin.y
                        )
                        .into(),
                    );
                    self.push_undo(edits);
                }
            }
        });

        // 0d. Check for pending world export request
        EXPORT_REQUESTED.with(|r| {
            if *r.borrow() {
                *r.borrow_mut() = false;
                let json = self.serialize_world();
                let len = json.len();
                EXPORT_RESULT.with(|res| *res.borrow_mut() = Some(json));
                web_sys::console::log_1(
                    &format!("[freedom-board] world exported: {} bytes", len).into(),
                );
            }
        });

        // 0e. Check for pending world import
        PENDING_IMPORT.with(|p| {
            if let Some(json) = p.borrow_mut().take() {
                self.import_world_from_json(&json);
            }
        });

        // 0f. Check for pending script reload — route each script to the
        // correct engine based on its declared scope.
        PENDING_SCRIPTS.with(|p| {
            if let Some(scripts) = p.borrow_mut().take() {
                // Clear both engines before recompiling. Each engine only
                // receives scripts that belong to its scope.
                self.scripts.clear_scripts();
                self.rules_engine.clear_scripts();

                let mut ai_ok = 0u32;
                let mut ai_fail = 0u32;
                let mut rules_ok = 0u32;
                let mut rules_fail = 0u32;
                let mut worldgen_count = 0u32;
                let mut unknown_count = 0u32;

                for (name, entry) in &scripts {
                    match entry.scope.as_str() {
                        "character_ai" => {
                            match self.scripts.compile_script(name, &entry.source) {
                                Ok(_) => ai_ok += 1,
                                Err(e) => {
                                    web_sys::console::error_1(
                                        &format!("[freedom-board] AI script '{}' compile error: {:?}", name, e).into(),
                                    );
                                    ai_fail += 1;
                                }
                            }
                        }
                        "rules" => {
                            match self.rules_engine.compile_script(name, &entry.source) {
                                Ok(_) => rules_ok += 1,
                                Err(e) => {
                                    web_sys::console::error_1(
                                        &format!("[freedom-board] rules script '{}' compile error: {:?}", name, e).into(),
                                    );
                                    rules_fail += 1;
                                }
                            }
                        }
                        "world_gen" => {
                            // World gen engine not yet wired (Track E — WorldGenContext).
                            // Script is stored in IDB but skipped at the WASM layer for now.
                            worldgen_count += 1;
                        }
                        other => {
                            web_sys::console::warn_1(
                                &format!("[freedom-board] unknown script scope '{}' for '{}'", other, name).into(),
                            );
                            unknown_count += 1;
                        }
                    }
                }
                web_sys::console::log_1(
                    &format!(
                        "[freedom-board] scripts reloaded: AI {}/{}, rules {}/{}, worldgen {} (deferred){}",
                        ai_ok, ai_ok + ai_fail,
                        rules_ok, rules_ok + rules_fail,
                        worldgen_count,
                        if unknown_count > 0 { format!(", {} unknown scope", unknown_count) } else { String::new() },
                    ).into(),
                );
            }
        });

        // 0g. Check for pending game session operations (load def, start, stop)
        self.check_pending_game_session();

        // 0h. Process pending character script assignments
        PENDING_SCRIPT_ASSIGNMENT.with(|p| {
            let assignments = std::mem::take(&mut *p.borrow_mut());
            for (actor_id_u32, script_name) in assignments {
                let actor_id = ActorId(actor_id_u32);
                let found = if let Some(actor) = self.characters.get_mut(&actor_id) {
                    let old = actor.script_name.clone();
                    actor.script_name = script_name.clone();
                    web_sys::console::log_1(
                        &format!(
                            "[freedom-board] character {} script: {:?} → {:?}",
                            actor_id_u32, old, script_name
                        ).into(),
                    );
                    self.characters_dirty = true;
                    true
                } else {
                    false
                };
                // Refresh selected-character info after the mutable borrow
                // is released, so write_selected_character_info can borrow
                // self.characters immutably.
                if found && self.selected_character == Some(actor_id) {
                    self.write_selected_character_info();
                }
                if !found {
                    web_sys::console::warn_1(
                        &format!("[freedom-board] assign_script: actor {} not found", actor_id_u32).into(),
                    );
                }
            }
        });

        // 1. Process all custom events from React
        for event in input.iter() {
            if let InputEvent::Custom { kind, a, b, c } = event {
                self.handle_custom_event(*kind, *a, *b, *c);
            }
        }

        // 1a. Run game session orchestrator (emit events, execute rules script, apply commands)
        self.run_orchestrator(1.0 / 60.0);

        // 1b. Run Rhai scripts for characters with assigned script_ids (legacy AI path)
        self.run_scripts();

        // 1c. Update character movement (smooth interpolation toward targets)
        self.update_character_movement();

        // 1d. Update character animation frames (walk cycle, idle cycle)
        self.update_animation_frames();

        // 2. Rebuild visible entities if world or camera changed
        let world_changed = self.world.generation() != self.last_rendered_generation;
        if world_changed || self.camera_dirty {
            self.rebuild_visible_entities(ctx);
            self.last_rendered_generation = self.world.generation();
            self.camera_dirty = false;
            self.characters_dirty = true; // camera moved, redraw characters
        }

        // 3. Draw vector overlays (cleared each frame, must redraw every update)
        if self.debug_show_grid {
            self.draw_grid(ctx);
        }
        if self.debug_show_crosshair {
            self.draw_origin_crosshair(ctx);
        }
        if self.debug_show_quadtree {
            self.draw_quadtree_debug(ctx);
        }

        // 4. Characters are drawn as vectors (cleared each frame), so always redraw
        if !self.characters.is_empty() {
            self.rebuild_character_entities(ctx);
        }

        // 4. Emit stats to React
        self.emit_stats_if_changed(ctx);

        // 5. Emit pending session state events to React
        for code in self.pending_session_events.drain(..) {
            ctx.emit_event(GameEvent {
                kind: game_events::SESSION_STATE as f32,
                a: code as f32,
                b: 0.0,
                c: 0.0,
            });
        }
    }

    fn render(&self, _ctx: &mut RenderContext) {
        // Rendering is handled by entity spawn/despawn in update().
        // The engine's renderer draws all spawned entities automatically.
    }
}

// ── WASM Exports ────────────────────────────────────────────────────────────

/// Scoped script entry for hot-reload. Carries source code and the scope
/// that determines which Rhai engine compiles it:
/// - "rules"        → RulesScriptEngine (on_event entry point)
/// - "character_ai" → legacy ScriptEngine (update entry point)
/// - "world_gen"    → deferred (Track E — WorldGenContext not yet wired)
#[derive(serde::Deserialize)]
struct PendingScript {
    source: String,
    scope: String,
}

thread_local! {
    static PENDING_TILE_REGISTRY: std::cell::RefCell<Option<Vec<TileAssetInfo>>> =
        std::cell::RefCell::new(None);
    static PENDING_CHARACTER_NAMES: std::cell::RefCell<Option<Vec<String>>> =
        std::cell::RefCell::new(None);
    static PENDING_CHARACTER_EQUIPMENT: std::cell::RefCell<Option<Vec<(Option<String>, Option<String>)>>> =
        std::cell::RefCell::new(None);
    static PENDING_STAMP: std::cell::RefCell<Option<(TileCoord, Vec<(TileCoord, TilePlacement)>)>> =
        std::cell::RefCell::new(None);

    /// Flag set by `request_world_export()`. Consumed by update(), which serializes
    /// the world and writes the result to EXPORT_RESULT.
    static EXPORT_REQUESTED: std::cell::RefCell<bool> =
        std::cell::RefCell::new(false);
    /// Serialized world JSON, written by update() when EXPORT_REQUESTED is true.
    /// Read and cleared by `take_world_export()`.
    static EXPORT_RESULT: std::cell::RefCell<Option<String>> =
        std::cell::RefCell::new(None);
    /// Queued world JSON for import. Set by `import_world()`, consumed by update().
    static PENDING_IMPORT: std::cell::RefCell<Option<String>> =
        std::cell::RefCell::new(None);
    /// Queued Rhai scripts for hot-reload. Set by `reload_scripts()`, consumed by update().
    /// Map of script name → { source, scope }.
    static PENDING_SCRIPTS: std::cell::RefCell<Option<std::collections::HashMap<String, PendingScript>>> =
        std::cell::RefCell::new(None);
    /// Queued game definition JSON. Set by `load_game_definition()`, consumed by update().
    static PENDING_GAME_DEF: std::cell::RefCell<Option<String>> =
        std::cell::RefCell::new(None);
    /// Flag to start a game session. Set by `start_game()`, consumed by update().
    static PENDING_START_GAME: std::cell::RefCell<bool> =
        std::cell::RefCell::new(false);
    /// Flag to stop the active game session. Set by `stop_game()`, consumed by update().
    static PENDING_STOP_GAME: std::cell::RefCell<bool> =
        std::cell::RefCell::new(false);
    /// Queued script assignments: (actor_id_u32, Option<script_name>).
    /// Set by `assign_character_script()`, consumed by update().
    static PENDING_SCRIPT_ASSIGNMENT: std::cell::RefCell<Vec<(u32, Option<String>)>> =
        std::cell::RefCell::new(Vec::new());
    /// JSON string describing the currently selected character.
    /// Written by update() when selection changes, read by `take_selected_character_info()`.
    static SELECTED_CHARACTER_INFO: std::cell::RefCell<Option<String>> =
        std::cell::RefCell::new(None);
}

/// Load the tile asset registry. Called by the engine worker via `reload_game_manifest` dispatch.
///
/// JSON format:
/// ```json
/// [
///   {"name": "iarba", "variations": 3, "tileType": "TILE", "terrainType": "LAND"},
///   {"name": "river", "variations": 15, "tileType": "PATH", "terrainType": "WATER"},
///   {"name": "drum_gri", "variations": 15, "tileType": "PATH", "terrainType": "LAND",
///    "bridgeAssetId": "bridge_80px"},
///   ...
/// ]
/// ```
///
/// Array index becomes the tile's asset_id (u16). React and WASM must agree on ordering.
/// `bridgeAssetId` is resolved to a u16 index after all entries are parsed (two-pass).
#[wasm_bindgen]
pub fn reload_game_manifest(json: &str) {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TileEntry {
        name: String,
        #[serde(default = "default_variations")]
        variations: u8,
        #[serde(default)]
        tile_type: Option<String>,
        #[serde(default)]
        terrain_type: Option<String>,
        #[serde(default)]
        bridge_asset_id: Option<String>,
        #[serde(default = "default_passable")]
        passable: bool,
        #[serde(default = "default_movement_cost")]
        movement_cost: u8,
    }
    fn default_passable() -> bool { true }
    fn default_movement_cost() -> u8 { 10 }

    /// Character entry from manifest — name + optional equipment.
    #[derive(serde::Deserialize, Clone)]
    #[serde(untagged)]
    enum CharacterEntry {
        /// New format: { name, weaponDefId?, throwableDefId? }
        Full {
            name: String,
            #[serde(default, rename = "weaponDefId")]
            weapon_def_id: Option<String>,
            #[serde(default, rename = "throwableDefId")]
            throwable_def_id: Option<String>,
        },
        /// Legacy format: just the name string
        NameOnly(String),
    }

    impl CharacterEntry {
        fn name(&self) -> &str {
            match self {
                CharacterEntry::Full { name, .. } => name,
                CharacterEntry::NameOnly(n) => n,
            }
        }
        fn weapon(&self) -> Option<&str> {
            match self {
                CharacterEntry::Full { weapon_def_id, .. } => weapon_def_id.as_deref(),
                CharacterEntry::NameOnly(_) => None,
            }
        }
        fn throwable(&self) -> Option<&str> {
            match self {
                CharacterEntry::Full { throwable_def_id, .. } => throwable_def_id.as_deref(),
                CharacterEntry::NameOnly(_) => None,
            }
        }
    }

    /// Extended manifest payload: tiles + character entries.
    /// Falls back to parsing as flat Vec<TileEntry> for backward compat.
    #[derive(serde::Deserialize)]
    struct ManifestPayload {
        tiles: Vec<TileEntry>,
        #[serde(default)]
        characters: Vec<CharacterEntry>,
    }

    fn default_variations() -> u8 {
        1
    }

    // Try extended format first: { tiles: [...], characters: [...] }
    // Fall back to flat array for backward compat: [...]
    let (entries, char_entries) = match serde_json::from_str::<ManifestPayload>(json) {
        Ok(payload) => (payload.tiles, payload.characters),
        Err(_) => match serde_json::from_str::<Vec<TileEntry>>(json) {
            Ok(entries) => (entries, Vec::<CharacterEntry>::new()),
            Err(e) => {
                web_sys::console::error_1(
                    &format!("[freedom-board] manifest parse error: {}", e).into(),
                );
                return;
            }
        },
    };

    // First pass: build name → index lookup for bridge_asset_id resolution
    let name_to_idx: std::collections::HashMap<&str, u16> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.name.as_str(), i as u16))
        .collect();

    // Second pass: build registry with resolved bridge references
    let registry: Vec<TileAssetInfo> = entries
        .iter()
        .map(|e| {
            let tile_type = match e.tile_type.as_deref() {
                Some("PATH") => TileType::Path,
                Some("BRIDGE") => TileType::Bridge,
                _ => TileType::Tile,
            };
            let terrain_type = match e.terrain_type.as_deref() {
                Some("WATER") => TerrainType::Water,
                _ => TerrainType::Land,
            };
            let bridge_asset_id = e
                .bridge_asset_id
                .as_deref()
                .and_then(|name| name_to_idx.get(name).copied());

            TileAssetInfo {
                name: e.name.clone(),
                variations: e.variations,
                tile_type,
                terrain_type,
                bridge_asset_id,
                passable: e.passable,
                movement_cost: e.movement_cost,
            }
        })
        .collect();

    // Extract character names and equipment from entries
    let char_names: Vec<String> = char_entries.iter().map(|e| e.name().to_string()).collect();
    let char_equipment: Vec<(Option<String>, Option<String>)> = char_entries
        .iter()
        .map(|e| (e.weapon().map(|s| s.to_string()), e.throwable().map(|s| s.to_string())))
        .collect();

    let tile_count = registry.len();
    let char_count = char_names.len();
    PENDING_TILE_REGISTRY.with(|p| *p.borrow_mut() = Some(registry));
    PENDING_CHARACTER_NAMES.with(|p| *p.borrow_mut() = Some(char_names));
    PENDING_CHARACTER_EQUIPMENT.with(|p| *p.borrow_mut() = Some(char_equipment));
    web_sys::console::log_1(
        &format!(
            "[freedom-board] manifest queued: {} tiles, {} characters",
            tile_count, char_count
        )
        .into(),
    );
}

/// Stamp a map (LDtk level) onto the infinite canvas.
///
/// Called by the engine worker via `load_level` dispatch.
/// React pre-resolves tile names to asset_ids and layers before sending.
///
/// JSON format:
/// ```json
/// {
///   "originX": 10, "originY": 5,
///   "tiles": [
///     {"x": 0, "y": 0, "assetId": 3, "layer": 0, "variant": 2},
///     ...
///   ]
/// }
/// ```
///
/// - `originX/Y`: top-left corner in tile coordinates where the stamp is placed
/// - `x/y`: offset from origin (not absolute coords)
/// - `assetId`: u16 tile asset index (resolved by React from tile name)
/// - `layer`: render/storage layer (derived by React from tileType/terrainType)
/// - `variant`: sprite variation (for TILE: seed % variations, for PATH: 0)
#[wasm_bindgen]
pub fn load_level(json: &str) {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StampPayload {
        origin_x: i32,
        origin_y: i32,
        tiles: Vec<StampTile>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StampTile {
        x: i32,
        y: i32,
        asset_id: u16,
        layer: u8,
        variant: u8,
    }

    let payload: StampPayload = match serde_json::from_str(json) {
        Ok(p) => p,
        Err(e) => {
            web_sys::console::error_1(
                &format!("[freedom-board] stamp parse error: {}", e).into(),
            );
            return;
        }
    };

    let origin = TileCoord::new(payload.origin_x, payload.origin_y);
    let tiles: Vec<(TileCoord, TilePlacement)> = payload
        .tiles
        .into_iter()
        .map(|t| {
            (
                TileCoord::new(t.x, t.y),
                TilePlacement::new(t.asset_id, t.variant, t.layer),
            )
        })
        .collect();

    let count = tiles.len();
    PENDING_STAMP.with(|p| *p.borrow_mut() = Some((origin, tiles)));
    web_sys::console::log_1(
        &format!(
            "[freedom-board] stamp queued: {} tiles at ({}, {})",
            count, payload.origin_x, payload.origin_y
        )
        .into(),
    );
}

// ── World persistence exports ────────────────────────────────────────────────
//
// Two-phase export pattern (request → tick → take):
//   1. Worker calls request_world_export()     → sets flag
//   2. Worker calls game_tick()                → update() serializes world, writes to EXPORT_RESULT
//   3. Worker calls take_world_export()        → returns JSON string, clears EXPORT_RESULT
//
// Import is single-phase (queue → tick consumes):
//   1. Worker calls import_world(json)         → queues JSON in PENDING_IMPORT
//   2. Next game_tick() → update() deserializes and replaces world state

/// Request world serialization. The result will be available after the next game_tick()
/// via `take_world_export()`.
///
/// This two-phase pattern exists because the game instance is owned by the engine
/// macro and cannot be accessed directly from free functions. The flag is checked
/// during update() which has &mut self access.
#[wasm_bindgen]
pub fn request_world_export() {
    EXPORT_REQUESTED.with(|r| *r.borrow_mut() = true);
    web_sys::console::log_1(&"[freedom-board] world export requested".into());
}

/// Take the serialized world JSON from the last export request.
/// Returns None if no export has been completed yet.
/// Clears the result — subsequent calls return None until a new export is requested.
#[wasm_bindgen]
pub fn take_world_export() -> Option<String> {
    EXPORT_RESULT.with(|r| r.borrow_mut().take())
}

/// Queue a world import from JSON. The world will be replaced on the next game_tick().
///
/// JSON format matches the IDB WorldData schema:
/// ```json
/// {
///   "version": 1,
///   "tiles": [{ "x": 0, "y": 0, "uuid": "iarba", "variant": 2, "layer": 0, "flags": 0 }],
///   "characters": [{ "x": 5.5, "y": 10.5, "bodyDefId": "warrior", "direction": "south",
///                     "health": 100, "maxHealth": 100 }],
///   "camera": { "x": 0.0, "y": 0.0, "zoom": 64.0 }
/// }
/// ```
///
/// Clears undo/redo stacks — the imported state becomes the new baseline.
#[wasm_bindgen]
pub fn import_world(json: &str) {
    let len = json.len();
    PENDING_IMPORT.with(|p| *p.borrow_mut() = Some(json.to_string()));
    web_sys::console::log_1(
        &format!("[freedom-board] world import queued: {} bytes", len).into(),
    );
}

/// Reload Rhai scripts. Called from React when scripts change.
///
/// JSON format: `{ "name": { "source": "fn ...", "scope": "rules"|"character_ai"|"world_gen" }, ... }`
///
/// Each script is routed to the correct engine based on its scope:
/// - "rules"        → RulesScriptEngine
/// - "character_ai" → legacy ScriptEngine (AI per-character)
/// - "world_gen"    → not yet wired (logged and skipped)
///
/// Scripts are compiled on the next game tick. Compilation errors are
/// logged to the browser console but do not crash the game.
#[wasm_bindgen]
pub fn reload_scripts(scripts_json: &str) {
    match serde_json::from_str::<std::collections::HashMap<String, PendingScript>>(scripts_json) {
        Ok(scripts) => {
            let count = scripts.len();
            PENDING_SCRIPTS.with(|p| *p.borrow_mut() = Some(scripts));
            web_sys::console::log_1(
                &format!("[freedom-board] {} scripts queued for reload", count).into(),
            );
        }
        Err(e) => {
            web_sys::console::error_1(
                &format!("[freedom-board] failed to parse scripts JSON: {}", e).into(),
            );
        }
    }
}

// ── Game session WASM exports ───────────────────────────────────────────────

/// Load a GameDefinition from JSON. Parses and stores for later `start_game()`.
/// Also compiles the rules script if present in the pending scripts cache.
#[wasm_bindgen]
pub fn load_game_definition(json: &str) {
    PENDING_GAME_DEF.with(|p| *p.borrow_mut() = Some(json.to_string()));
    web_sys::console::log_1(&"[freedom-board] game definition queued for loading".into());
}

/// Start a game session from the loaded GameDefinition.
/// Requires a definition to be loaded first via `load_game_definition()`.
#[wasm_bindgen]
pub fn start_game() {
    PENDING_START_GAME.with(|p| *p.borrow_mut() = true);
    web_sys::console::log_1(&"[freedom-board] game start requested".into());
}

/// Stop the active game session and return to edit mode.
#[wasm_bindgen]
pub fn stop_game() {
    PENDING_STOP_GAME.with(|p| *p.borrow_mut() = true);
    web_sys::console::log_1(&"[freedom-board] game stop requested".into());
}

// ── Character script assignment WASM exports ────────────────────────────────

/// Assign a named script to a character. Called from React when the user
/// selects a script in the character property panel.
///
/// `actor_id_f32`: The ActorId as f32 (safe up to 2^24).
/// `script_name`: Script name from IDB scripts store, or empty string to clear.
#[wasm_bindgen]
pub fn assign_character_script(actor_id_f32: f32, script_name: &str) {
    PENDING_SCRIPT_ASSIGNMENT.with(|p| {
        let actor_id = actor_id_f32 as u32;
        let name = if script_name.is_empty() { None } else { Some(script_name.to_string()) };
        p.borrow_mut().push((actor_id, name));
    });
}

/// Return JSON info about the currently selected character, or empty string
/// if none is selected. Called by the worker after each frame to provide
/// selection data to React.
///
/// Returns: `{ "actorId": 5, "bodyDefId": "marine", "scriptName": "patrol_ai", "x": 3.5, "y": 7.5 }`
/// or `""` if no character is selected.
#[wasm_bindgen]
pub fn take_selected_character_info() -> String {
    SELECTED_CHARACTER_INFO.with(|p| p.borrow_mut().take().unwrap_or_default())
}

// Export the game using zap-web macro.
// This generates all wasm-bindgen exports: game_init, game_tick, game_custom_event, etc.
zap_web::export_game!(FreedomBoardGame, "freedom_board", vectors);
