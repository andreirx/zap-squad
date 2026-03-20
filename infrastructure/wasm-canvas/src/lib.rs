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
//! entity_scale = zoom (one tile = zoom pixels)
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
//! | 100  | camera_x     | camera_y     | zoom (px/tile) | Camera state update |
//! | 101  | width_px     | height_px    | —              | Viewport resize     |
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
    SparseWorld, TileCoord, TilePlacement, VisibleTile,
};
use zapsquad_core::use_cases::freedom_board::{
    place_tile, erase_tile, query_viewport, EditResult,
};

/// Custom event kinds: React -> WASM
mod events {
    pub const PLACE_TILE: u32 = 1;
    pub const ERASE_TILE: u32 = 2;
    pub const SET_TOOL: u32 = 3;
    pub const SET_ACTIVE_TILE: u32 = 4;
    pub const CAMERA_UPDATE: u32 = 100;
    pub const VIEWPORT_SIZE: u32 = 101;
}

/// Game event kinds: WASM -> React
mod game_events {
    pub const WORLD_STATS: u32 = 1;
}

/// Editor tool modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Tool {
    Pan = 0,
    Draw = 1,
    Erase = 2,
    Fill = 3,
}

impl Tool {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Tool::Pan,
            1 => Tool::Draw,
            2 => Tool::Erase,
            3 => Tool::Fill,
            _ => Tool::Pan,
        }
    }
}

/// Per-tile metadata from manifest.json, indexed by asset_id (u16).
/// Populated once at startup via `register_tiles()`.
#[derive(Clone, Debug)]
struct TileAssetInfo {
    /// String name used in sprite lookup: e.g. "iarba", "ocean", "river"
    name: String,
    /// Number of base variations (atlas columns). Needed to compute
    /// transition sprite indices: transition_index = (1 + dir) * variations + variation.
    variations: u8,
}

/// Main game struct implementing zap-engine's Game trait.
///
/// Owns the SparseWorld and translates between the engine's entity system
/// and the core's tile coordinate model.
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
    viewport_width: f32,  // canvas width in pixels
    viewport_height: f32, // canvas height in pixels

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

    // ── Stats tracking ──────────────────────────────────────────────────
    /// Last tile_count sent to React, to avoid spamming events.
    last_reported_tile_count: u64,
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

            tile_entities: Vec::new(),
            last_rendered_generation: u64::MAX, // force initial render
            camera_dirty: true,

            active_asset_id: 0,
            active_layer: 0,
            active_variant: 0,
            tool: Tool::Draw,

            last_reported_tile_count: u64::MAX,
        }
    }

    /// Look up the tile name for an asset_id. Returns None if not registered.
    fn tile_name(&self, asset_id: u16) -> Option<&str> {
        self.tile_registry.get(asset_id as usize).map(|t| t.name.as_str())
    }

    /// Process a custom event from React.
    fn handle_custom_event(&mut self, kind: u32, a: f32, b: f32, c: f32) {
        match kind {
            events::PLACE_TILE => {
                let coord = TileCoord::new(a as i32, b as i32);
                let tile = TilePlacement::new(c as u16, self.active_variant, self.active_layer);
                let edit = place_tile(&mut self.world, coord, tile);
                self.undo_stack.push(vec![edit]);
                self.redo_stack.clear();
            }
            events::ERASE_TILE => {
                let coord = TileCoord::new(a as i32, b as i32);
                if self.world.get(coord).is_some() {
                    let edit = erase_tile(&mut self.world, coord);
                    self.undo_stack.push(vec![edit]);
                    self.redo_stack.clear();
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

    /// Despawn all current tile entities, query visible tiles, spawn new entities.
    ///
    /// Sprite lookup: `ctx.sprite("{tile_name}_{variant}")` using the tile registry
    /// to resolve asset_id (u16) → tile name (string).
    ///
    /// TODO(perf): Entity pooling — reuse EntityIds, only update positions on camera pan.
    /// Current approach: full despawn/respawn. Acceptable for <10K visible tiles.
    fn rebuild_visible_entities(&mut self, ctx: &mut EngineContext) {
        // Despawn old entities
        for entity_id in self.tile_entities.drain(..) {
            ctx.despawn(entity_id);
        }

        let (vp_min, vp_max) = self.visible_bounds();
        let visible: Vec<VisibleTile> = query_viewport(&self.world, vp_min, vp_max);

        for vt in &visible {
            let id = ctx.next_id();

            // Convert tile center to screen pixels
            let screen_x = (vt.x as f32 + 0.5 - self.camera_x) * self.zoom;
            let screen_y = (vt.y as f32 + 0.5 - self.camera_y) * self.zoom;

            let layer = match vt.placement.layer {
                0 => RenderLayer::Background,
                1 => RenderLayer::Terrain,
                2 => RenderLayer::Objects,
                3 => RenderLayer::Foreground,
                4 => RenderLayer::VFX,
                _ => RenderLayer::UI,
            };

            let mut entity = Entity::new(id)
                .with_pos(Vec2::new(screen_x, screen_y))
                .with_scale(Vec2::splat(self.zoom))
                .with_layer(layer);

            // Resolve asset_id → tile name via registry, then look up sprite
            if let Some(tile_name) = self.tile_name(vt.placement.asset_id) {
                let sprite_key = format!("{}_{}", tile_name, vt.placement.variant);
                if let Some(sprite) = ctx.sprite(&sprite_key) {
                    entity.sprite = Some(sprite);
                }
                // If sprite not found, entity renders as invisible — expected for
                // tiles whose atlas hasn't loaded yet.
            }
            // If asset_id not in registry, entity is invisible — expected before
            // register_tiles() is called.

            ctx.scene.spawn(entity);
            self.tile_entities.push(id);
        }
    }

    /// Emit world stats to React if they changed.
    fn emit_stats_if_changed(&mut self, ctx: &mut EngineContext) {
        let tc = self.world.tile_count();
        if tc != self.last_reported_tile_count {
            self.last_reported_tile_count = tc;
            ctx.events.push(GameEvent {
                kind: game_events::WORLD_STATS as f32,
                a: tc as f32,
                b: self.world.chunk_count() as f32,
                c: 0.0,
            });
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
                self.camera_dirty = true; // force re-render with new sprites
            }
        });

        // 1. Process all custom events from React
        for event in input.iter() {
            if let InputEvent::Custom { kind, a, b, c } = event {
                self.handle_custom_event(*kind, *a, *b, *c);
            }
        }

        // 2. Rebuild visible entities if world or camera changed
        let world_changed = self.world.generation() != self.last_rendered_generation;
        if world_changed || self.camera_dirty {
            self.rebuild_visible_entities(ctx);
            self.last_rendered_generation = self.world.generation();
            self.camera_dirty = false;
        }

        // 3. Emit stats to React
        self.emit_stats_if_changed(ctx);
    }

    fn render(&self, _ctx: &mut RenderContext) {
        // Rendering is handled by entity spawn/despawn in update().
        // The engine's renderer draws all spawned entities automatically.
    }
}

// ── WASM Exports ────────────────────────────────────────────────────────────

thread_local! {
    static PENDING_TILE_REGISTRY: std::cell::RefCell<Option<Vec<TileAssetInfo>>> =
        std::cell::RefCell::new(None);
}

/// Load the tile asset registry. Called by the engine worker via `reload_game_manifest` dispatch.
///
/// JSON format: `[{"name": "iarba", "variations": 3}, {"name": "pamant", "variations": 2}, ...]`
///
/// Array index becomes the tile's asset_id (u16). React and WASM must agree on ordering.
/// For freedom-board, the "game manifest" IS the tile registry — different games use
/// different manifest formats, and the engine worker dispatches to this export generically.
#[wasm_bindgen]
pub fn reload_game_manifest(json: &str) {
    #[derive(serde::Deserialize)]
    struct TileEntry {
        name: String,
        variations: u8,
    }

    match serde_json::from_str::<Vec<TileEntry>>(json) {
        Ok(entries) => {
            let registry: Vec<TileAssetInfo> = entries
                .into_iter()
                .map(|e| TileAssetInfo {
                    name: e.name,
                    variations: e.variations,
                })
                .collect();
            let count = registry.len();
            PENDING_TILE_REGISTRY.with(|p| *p.borrow_mut() = Some(registry));
            web_sys::console::log_1(
                &format!("[freedom-board] tile registry: {} entries queued", count).into(),
            );
        }
        Err(e) => {
            web_sys::console::error_1(
                &format!("[freedom-board] tile registry parse error: {}", e).into(),
            );
        }
    }
}

// Export the game using zap-web macro.
// This generates all wasm-bindgen exports: game_init, game_tick, game_custom_event, etc.
zap_web::export_game!(FreedomBoardGame, "freedom_board");
