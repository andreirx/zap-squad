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
    SparseWorld, TileCoord, TilePlacement, VisibleTile, CHUNK_SIZE,
};
use zapsquad_core::use_cases::freedom_board::{
    connectivity_bitmask, place_tile, erase_tile, query_viewport, EditResult,
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
    viewport_width: f32,  // visible game-world width (projection-adjusted)
    viewport_height: f32, // visible game-world height (projection-adjusted)

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

    /// Look up full tile info for an asset_id.
    fn tile_info(&self, asset_id: u16) -> Option<&TileAssetInfo> {
        self.tile_registry.get(asset_id as usize)
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
                let layer = c as u8;
                if self.world.get(coord, layer).is_some() {
                    let edit = erase_tile(&mut self.world, coord, layer);
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
            //   PATH/BRIDGE: connectivity bitmask (same-asset neighbors on same layer)
            //   TILE: stored variant from TilePlacement
            let variation = if tile_type == TileType::Path || tile_type == TileType::Bridge {
                let bits = connectivity_bitmask(&self.world, coord, layer);
                if bits == 0 { 0 } else { bits - 1 }
            } else {
                vt.placement.variant
            };

            let render_layer = Self::storage_to_render_layer(layer);

            // Bridge auto-placement: LAND PATH over water → spawn bridge entity
            // on the bridge render layer (Objects) before spawning the path itself.
            if tile_type == TileType::Path && terrain_type == TerrainType::Land {
                if let Some(bridge_aid) = bridge_asset_id {
                    if self.check_water_underneath(coord) {
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
    fn check_water_underneath(&self, coord: TileCoord) -> bool {
        for layer in 0..2u8 {
            if let Some(tile) = self.world.get(coord, layer) {
                if let Some(info) = self.tile_info(tile.asset_id) {
                    if info.terrain_type == TerrainType::Water {
                        return true;
                    }
                }
            }
        }
        false
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

        // 3. Draw vector overlays (cleared each frame, must redraw every update)
        self.draw_grid(ctx);
        self.draw_origin_crosshair(ctx);
        self.draw_quadtree_debug(ctx);

        // 4. Emit stats to React
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
    }

    fn default_variations() -> u8 {
        1
    }

    match serde_json::from_str::<Vec<TileEntry>>(json) {
        Ok(entries) => {
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
                    }
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
