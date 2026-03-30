//! ZapSquad WASM Entry Point
//!
//! This crate provides wasm-bindgen exports that bridge JavaScript
//! to the core/adapters layers. It integrates:
//! - CompositeActor for X-COM style layered characters
//! - CompositeRenderer for multi-entity rendering
//! - ScriptEngine with hot-reload support
//! - LDtk level loading

use glam::Vec2;
use wasm_bindgen::prelude::*;

use zap_engine::*;

use zapsquad_adapters::{
    engine_gateway::RenderRequest,
    asset_gateway::TileDefinition,
    AssetGateway, AssetManifest, CompositeRenderer, EngineGateway, InputAdapter,
    InputEvent as AdapterInputEvent,
    script_bindings::{ScriptCommand, ScriptContext, ScriptEngine, WorldQuery},
    TileInstance,
};
use zapsquad_core::{ActorId, AnimationState, CompositeActor, GameState, ScriptId};

use std::collections::HashMap;

/// Custom event types for React -> WASM communication
mod events {
    pub const RELOAD_SCRIPTS: u32 = 1;
    pub const RELOAD_MANIFEST: u32 = 2;
    pub const LOAD_LEVEL: u32 = 3;
    pub const SPAWN_ACTOR: u32 = 4;
}

/// Convert key code to key name
fn key_code_to_name(code: u32) -> Option<String> {
    match code {
        37 => Some("ArrowLeft".to_string()),
        38 => Some("ArrowUp".to_string()),
        39 => Some("ArrowRight".to_string()),
        40 => Some("ArrowDown".to_string()),
        65 => Some("a".to_string()),
        68 => Some("d".to_string()),
        83 => Some("s".to_string()),
        87 => Some("w".to_string()),
        32 => Some("Space".to_string()),
        13 => Some("Enter".to_string()),
        27 => Some("Escape".to_string()),
        _ => None,
    }
}

/// Main game struct implementing zap-engine's Game trait
pub struct ZapSquadGame {
    // Core state
    state: GameState,
    composite_actors: HashMap<ActorId, CompositeActor>,
    next_actor_id: u32,

    // Tile entities (static, created from level)
    tile_entities: Vec<EntityId>,
    tiles: Vec<TileInstance>,

    // Tile definitions for sprite index calculation
    tile_defs: HashMap<String, TileDefinition>,

    // Adapters
    gateway: EngineGateway,
    composite_renderer: CompositeRenderer,
    input: InputAdapter,
    scripts: ScriptEngine,

    // Timing
    time: f32,

    // Camera state (for viewport culling)
    camera_x: f32,
    camera_y: f32,
    camera_zoom: f32,
    viewport_width: f32,
    viewport_height: f32,
    camera_dirty: bool,

    // Pending reload data (set via custom events, processed in update)
    pending_scripts: Option<HashMap<String, String>>,
    pending_manifest: Option<String>,
    pending_level: Option<String>,
    pending_sprite_manifest: Option<String>,
}

impl ZapSquadGame {
    pub fn new() -> Self {
        Self {
            state: GameState::new(),
            composite_actors: HashMap::new(),
            next_actor_id: 1,
            tile_entities: Vec::new(),
            tiles: Vec::new(),
            tile_defs: HashMap::new(),
            gateway: EngineGateway::new(),
            composite_renderer: CompositeRenderer::default(),
            input: InputAdapter::new(),
            scripts: ScriptEngine::new(),
            time: 0.0,
            camera_x: 0.0,
            camera_y: 0.0,
            camera_zoom: 1.0,
            viewport_width: 800.0,
            viewport_height: 600.0,
            camera_dirty: true,
            pending_scripts: None,
            pending_manifest: None,
            pending_level: None,
            pending_sprite_manifest: None,
        }
    }

    /// Generate next actor ID
    fn next_id(&mut self) -> ActorId {
        let id = ActorId(self.next_actor_id);
        self.next_actor_id += 1;
        id
    }

    /// Spawn a composite actor
    fn spawn_composite(
        &mut self,
        position: Vec2,
        body_def_id: &str,
        tag: &str,
    ) -> ActorId {
        let id = self.next_id();
        let actor = CompositeActor::new(id, position, body_def_id).with_tag(tag);
        self.composite_actors.insert(id, actor);
        id
    }

    /// Spawn a composite actor with weapon
    fn spawn_composite_with_weapon(
        &mut self,
        position: Vec2,
        body_def_id: &str,
        weapon_def_id: &str,
        tag: &str,
    ) -> ActorId {
        let id = self.next_id();
        let actor = CompositeActor::new(id, position, body_def_id)
            .with_weapon(weapon_def_id)
            .with_tag(tag);
        self.composite_actors.insert(id, actor);
        id
    }

    /// Process pending hot-reload data (returns sprite manifest to load in update with ctx)
    fn process_pending_reloads(&mut self) -> (Option<String>, bool) {
        // Check thread_local storage for pending reloads from WASM exports
        PENDING_SCRIPTS.with(|p| {
            if let Some(scripts) = p.borrow_mut().take() {
                self.pending_scripts = Some(scripts);
            }
        });
        PENDING_GAME_MANIFEST.with(|p| {
            if let Some(manifest) = p.borrow_mut().take() {
                self.pending_manifest = Some(manifest);
            }
        });
        PENDING_SPRITE_MANIFEST.with(|p| {
            if let Some(manifest) = p.borrow_mut().take() {
                self.pending_sprite_manifest = Some(manifest);
            }
        });
        PENDING_LEVEL.with(|p| {
            if let Some(level) = p.borrow_mut().take() {
                self.pending_level = Some(level);
            }
        });

        // Reload scripts
        if let Some(scripts) = self.pending_scripts.take() {
            self.scripts.clear_scripts();
            for (name, source) in scripts {
                if let Err(e) = self.scripts.compile_script(&name, &source) {
                    web_sys::console::error_1(
                        &format!("Failed to compile script '{}': {:?}", name, e).into(),
                    );
                }
            }
            web_sys::console::log_1(&format!("Loaded {} scripts", self.scripts.list_scripts().len()).into());
        }

        // Reload game manifest (body/weapon definitions for CompositeRenderer + tile definitions)
        if let Some(manifest_json) = self.pending_manifest.take() {
            // Parse tile definitions for sprite index calculation
            match AssetGateway::parse_tile_manifest(&manifest_json) {
                Ok(tile_defs) => {
                    web_sys::console::log_1(&format!("Loaded {} tile definitions", tile_defs.len()).into());
                    self.tile_defs = tile_defs;
                }
                Err(e) => {
                    web_sys::console::warn_1(&format!("Failed to parse tile manifest: {:?}", e).into());
                }
            }

            // Parse body/weapon definitions for CompositeRenderer
            // Use from_game_manifest to adapt the manifest.json format to internal format
            match AssetManifest::from_game_manifest(&manifest_json) {
                Ok(manifest) => {
                    web_sys::console::log_1(&format!(
                        "Game manifest reloaded: {} bodies, {} weapons",
                        manifest.bodies.len(),
                        manifest.weapons.len()
                    ).into());
                    self.composite_renderer.reload_manifest(manifest);
                }
                Err(e) => {
                    web_sys::console::error_1(&format!("Failed to parse game manifest: {:?}", e).into());
                }
            }
        }

        let mut level_loaded = false;
        // Load level
        if let Some(level_json) = self.pending_level.take() {
            self.load_level_from_json(&level_json);
            level_loaded = true;
        }

        // Return sprite manifest and level load status for update()
        (self.pending_sprite_manifest.take(), level_loaded)
    }

    /// Load level from LDtk JSON
    fn load_level_from_json(&mut self, json: &str) {
        // Clear existing actors and tiles
        self.composite_actors.clear();
        self.tiles.clear();

        // Try to find level name - use first level if not specified
        let level_names = match AssetGateway::list_levels(json) {
            Ok(names) => names,
            Err(e) => {
                web_sys::console::error_1(&format!("Failed to list levels: {}", e).into());
                // Fallback to test actor
                self.spawn_composite(Vec2::new(400.0, 300.0), "carnat_test", "player");
                return;
            }
        };

        let level_name = level_names.first().cloned().unwrap_or_else(|| "Level_0".to_string());

        // Load tiles with proper sprite index calculation
        match AssetGateway::get_tiles_with_manifest(json, &level_name, &self.tile_defs) {
            Ok(tiles) => {
                web_sys::console::log_1(&format!(
                    "Loaded {} tiles from level '{}'",
                    tiles.len(), level_name
                ).into());
                self.tiles = tiles;
            }
            Err(e) => {
                web_sys::console::error_1(&format!("Failed to load tiles: {}", e).into());
            }
        }

        // Build script map from loaded scripts
        let script_map: HashMap<String, ScriptId> = self
            .scripts
            .list_scripts()
            .iter()
            .enumerate()
            .map(|(i, name)| ((*name).to_string(), ScriptId(i as u32 + 1)))
            .collect();

        // Load level and actors
        match AssetGateway::load_level_actors(json, &level_name, &script_map, &mut self.next_actor_id) {
            Ok((_level, actors)) => {
                // Insert all actors
                for actor in actors {
                    self.composite_actors.insert(actor.id, actor);
                }
                web_sys::console::log_1(
                    &format!("Level '{}' loaded: {} tiles, {} actors",
                        level_name, self.tiles.len(), self.composite_actors.len()).into()
                );
            }
            Err(e) => {
                web_sys::console::error_1(&format!("Failed to load level: {}", e).into());
                // Fallback to test actor
                self.spawn_composite(Vec2::new(400.0, 300.0), "carnat_test", "player");
            }
        }
    }

    /// Spawn tile entities from loaded tiles (requires ctx)
    fn spawn_tile_entities(&mut self, ctx: &mut EngineContext) {
        // Clear old tile entities
        for entity_id in self.tile_entities.drain(..) {
            ctx.despawn(entity_id);
        }

        // Calculate visible bounds with margin for partial visibility
        // Use 2 tile widths as padding so objects are visible when entering the view
        let tile_size = self.tiles.first().map(|t| t.size).unwrap_or(128.0);
        let margin = tile_size * 2.0;
        let view_left = self.camera_x - margin;
        let view_right = self.camera_x + self.viewport_width + margin;
        let view_top = self.camera_y - margin;
        let view_bottom = self.camera_y + self.viewport_height + margin;

        // Closure to check if a tile position is within visible viewport
        let is_visible = |pos: Vec2, size: f32| -> bool {
            pos.x + size > view_left
                && pos.x < view_right
                && pos.y + size > view_top
                && pos.y < view_bottom
        };

        // Camera offset for converting world -> screen coordinates
        let camera_offset = Vec2::new(self.camera_x, self.camera_y);
        let zoom = self.camera_zoom;

        // Debug: log first visible tile's transform
        let mut debug_logged = false;

        let mut sprites_found = 0;
        let mut sprites_missing = 0;
        let mut tiles_culled = 0;

        // Create new tile entities
        for tile in &self.tiles {
            // VIEWPORT CULLING: Skip tiles outside visible area
            if !is_visible(tile.position, tile.size) {
                tiles_culled += 1;
                continue;
            }
            let id = ctx.next_id();

            // Center position: position is top-left, add half size to center sprite
            // Then convert from world coordinates to screen coordinates
            let world_center = tile.position + Vec2::splat(tile.size / 2.0);
            let center_pos = (world_center - camera_offset) * zoom;

            // Debug: log first tile's transform
            if !debug_logged {
                web_sys::console::log_1(&format!(
                    "[Tile] world=({:.0},{:.0}) -> screen=({:.0},{:.0}) cam=({:.0},{:.0}) zoom={:.2}",
                    world_center.x, world_center.y, center_pos.x, center_pos.y,
                    camera_offset.x, camera_offset.y, zoom
                ).into());
                debug_logged = true;
            }

            // Determine layer based on tile type AND asset_id pattern
            // User requested layer order (6 distinct levels):
            //   Background(0): land + water (pamant, iarba, ocean)
            //   Terrain(1): transition tiles (dirt_on_grass, zone_de_mustar - the blurry overlays)
            //   Objects(2): river (water paths)
            //   Foreground(3): bridges
            //   VFX(4): paths (drum_gri, mud, asfalt, gard)
            //   UI(5): characters & objects (set in composite_renderer)
            // Layer assignment based on tile_type AND terrain_type
            // JS renderer order: terrain → transitions → rivers → bridges → ground paths → characters
            let layer = match tile.tile_type.as_deref() {
                Some("PATH") => {
                    // Differentiate: water paths (rivers) go under bridges, ground paths go on top
                    if tile.terrain_type.as_deref() == Some("WATER") {
                        RenderLayer::Objects     // Rivers (layer 2) - under bridges
                    } else {
                        RenderLayer::VFX         // Ground paths (layer 4) - on top of bridges
                    }
                }
                Some("BRIDGE") => RenderLayer::Foreground, // Bridges (layer 3)
                Some("TRANSITION") => RenderLayer::Terrain, // Transitions (layer 1)
                Some("WATER") | Some("TILE") => RenderLayer::Background, // Base terrain (layer 0)
                _ => {
                    // Infer from asset_id pattern when tileType is missing
                    let aid = tile.asset_id.as_str();
                    if aid == "river" {
                        RenderLayer::Objects   // River (layer 2)
                    } else if aid.contains("drum") || aid.contains("mud") || aid == "dirtt"
                           || aid.contains("asfalt") || aid.contains("gard")
                           || aid.contains("dirt_40") {
                        RenderLayer::VFX       // Ground paths (layer 4)
                    } else if aid.contains("bridge") {
                        RenderLayer::Foreground // Bridges (layer 3)
                    } else if aid.contains("dirt_on") || aid.contains("zone_de") {
                        RenderLayer::Terrain   // Transitions (layer 1)
                    } else {
                        RenderLayer::Background // Base: ocean, pamant, iarba (layer 0)
                    }
                }
            };

            let mut entity = Entity::new(id)
                .with_pos(center_pos)
                .with_scale(Vec2::splat(tile.size * zoom))
                .with_layer(layer);

            // Use the pre-computed sprite_index from the adapter
            // Format: {asset_id}_{sprite_index} (e.g., "pamant_0", "river_7")
            let sprite_name = format!("{}_{}", tile.asset_id, tile.sprite_index);

            if let Some(sprite) = ctx.sprite(&sprite_name) {
                entity.sprite = Some(sprite);
                sprites_found += 1;
            } else {
                // Fallback: try base name without index
                if let Some(sprite) = ctx.sprite(&tile.asset_id) {
                    entity.sprite = Some(sprite);
                    sprites_found += 1;
                } else {
                    sprites_missing += 1;
                    // Log missing sprite for debugging (only first few)
                    if sprites_missing <= 3 {
                        web_sys::console::warn_1(&format!(
                            "Missing sprite: {} (tried {} and {})",
                            tile.asset_id, sprite_name, tile.asset_id
                        ).into());
                    }
                }
            }

            ctx.scene.spawn(entity);
            self.tile_entities.push(id);
        }

        // Reduce log spam - only log occasionally
        if self.tile_entities.len() != sprites_found + sprites_missing {
            web_sys::console::log_1(&format!(
                "Spawned {} tile entities ({} sprites found, {} missing, {} culled)",
                self.tile_entities.len(), sprites_found, sprites_missing, tiles_culled
            ).into());
        }

        // === TRANSITION RENDERING ===
        // Build terrain grid for neighbor checking
        let tile_size = self.tiles.first().map(|t| t.size as i32).unwrap_or(128);
        let mut terrain_grid: HashMap<(i32, i32), &TileInstance> = HashMap::new();

        // Only terrain tiles participate in transitions (not paths, rivers, bridges)
        let is_terrain_tile = |aid: &str| -> bool {
            !aid.contains("drum") && !aid.contains("mud") && aid != "dirtt"
                && !aid.contains("asfalt") && !aid.contains("gard") && !aid.contains("dirt_40")
                && !aid.contains("bridge") && aid != "river"
        };

        for tile in &self.tiles {
            if is_terrain_tile(&tile.asset_id) {
                let key = (tile.position.x as i32, tile.position.y as i32);
                terrain_grid.insert(key, tile);
            }
        }

        // Direction offsets (N, NE, E, SE, S, SW, W, NW) and their sprite row indices
        let directions: [(i32, i32, u32); 8] = [
            (0, -tile_size, 0),   // N
            (tile_size, -tile_size, 1),  // NE
            (tile_size, 0, 2),    // E
            (tile_size, tile_size, 3),   // SE
            (0, tile_size, 4),    // S
            (-tile_size, tile_size, 5),  // SW
            (-tile_size, 0, 6),   // W
            (-tile_size, -tile_size, 7), // NW
        ];

        let mut transitions_created = 0;

        for tile in &self.tiles {
            if !is_terrain_tile(&tile.asset_id) {
                continue;
            }

            let tx = tile.position.x as i32;
            let ty = tile.position.y as i32;

            for (dx, dy, dir_idx) in &directions {
                let nx = tx + dx;
                let ny = ty + dy;
                let neighbor_key = (nx, ny);

                // Determine if we should draw this tile's transition
                let should_draw = if let Some(neighbor) = terrain_grid.get(&neighbor_key) {
                    // Different tile - dominant tile (higher asset_id) wins
                    tile.asset_id > neighbor.asset_id
                } else {
                    // Neighbor is void - always project transition
                    true
                };

                if should_draw {
                    // VIEWPORT CULLING: Skip transitions outside visible area
                    // Transition is drawn at neighbor position (nx, ny)
                    let neighbor_pos = Vec2::new(nx as f32, ny as f32);
                    if !is_visible(neighbor_pos, tile.size) {
                        continue;
                    }

                    // Get variations count for this tile
                    let variations = self.tile_defs
                        .get(&tile.asset_id)
                        .map(|d| d.variations.max(1))
                        .unwrap_or(1);

                    // Transition sprite index: (1 + dir_idx) * variations + 0
                    // Row 0 = base, Row 1 = N, Row 2 = NE, etc.
                    let transition_sprite_idx = (1 + dir_idx) * variations;

                    let sprite_name = format!("{}_{}", tile.asset_id, transition_sprite_idx);

                    if let Some(sprite) = ctx.sprite(&sprite_name) {
                        let id = ctx.next_id();
                        // Convert world -> screen coordinates
                        let world_center = neighbor_pos + Vec2::splat(tile.size / 2.0);
                        let screen_pos = (world_center - camera_offset) * zoom;

                        let entity = Entity::new(id)
                            .with_pos(screen_pos)
                            .with_scale(Vec2::splat(tile.size * zoom))
                            .with_layer(RenderLayer::Terrain) // Transitions on layer 1
                            .with_sprite(sprite);

                        ctx.scene.spawn(entity);
                        self.tile_entities.push(id);
                        transitions_created += 1;
                    }
                }
            }
        }

        if transitions_created > 0 {
            web_sys::console::log_1(&format!(
                "Created {} transition entities",
                transitions_created
            ).into());
        }

        // === AUTO-BRIDGE GENERATION ===
        // Build water grid (ocean terrain + river paths)
        let mut water_grid: HashMap<(i32, i32), bool> = HashMap::new();
        for tile in &self.tiles {
            let key = (tile.position.x as i32, tile.position.y as i32);
            let is_water = tile.terrain_type.as_deref() == Some("WATER")
                || tile.asset_id == "ocean"
                || tile.asset_id == "river";
            if is_water {
                water_grid.insert(key, true);
            }
        }

        // Build ground path grid for bridge connectivity
        let mut ground_path_grid: HashMap<(i32, i32), &TileInstance> = HashMap::new();
        let is_ground_path = |tile: &TileInstance| -> bool {
            let aid = tile.asset_id.as_str();
            (aid.contains("drum") || aid.contains("mud") || aid == "dirtt"
                || aid.contains("asfalt") || aid.contains("gard") || aid.contains("dirt_40"))
                && tile.terrain_type.as_deref() != Some("WATER")
        };

        for tile in &self.tiles {
            if is_ground_path(tile) {
                let key = (tile.position.x as i32, tile.position.y as i32);
                ground_path_grid.insert(key, tile);
            }
        }

        // For each ground path over water, create a bridge
        let mut bridges_created = 0;
        let cardinal_directions: [(i32, i32, u32); 4] = [
            (0, -tile_size, 8),   // N = bit 3
            (0, tile_size, 4),    // S = bit 2
            (-tile_size, 0, 2),   // W = bit 1
            (tile_size, 0, 1),    // E = bit 0
        ];

        for tile in &self.tiles {
            if !is_ground_path(tile) {
                continue;
            }

            // VIEWPORT CULLING: Skip bridges outside visible area
            if !is_visible(tile.position, tile.size) {
                continue;
            }

            let tx = tile.position.x as i32;
            let ty = tile.position.y as i32;
            let key = (tx, ty);

            // Check if this ground path is over water
            if !water_grid.contains_key(&key) {
                continue;
            }

            // Get bridge asset ID
            let bridge_asset_id = match &tile.bridge_asset_id {
                Some(id) => id.clone(),
                None => continue, // No bridge defined for this path type
            };

            // Calculate bridge connectivity based on neighboring ground paths of same type
            let mut bits = 0u32;
            for (dx, dy, bit) in &cardinal_directions {
                let nx = tx + dx;
                let ny = ty + dy;
                if let Some(neighbor) = ground_path_grid.get(&(nx, ny)) {
                    // Only connect if neighbor is same path type
                    if neighbor.asset_id == tile.asset_id {
                        bits |= bit;
                    }
                }
            }

            // Bridge sprite index: 0 for isolated, bits-1 for connected (0-14)
            let bridge_sprite_idx = if bits == 0 { 0 } else { bits - 1 };
            let sprite_name = format!("{}_{}", bridge_asset_id, bridge_sprite_idx);

            if let Some(sprite) = ctx.sprite(&sprite_name) {
                let id = ctx.next_id();
                // Convert world -> screen coordinates
                let world_center = tile.position + Vec2::splat(tile.size / 2.0);
                let screen_pos = (world_center - camera_offset) * zoom;

                let entity = Entity::new(id)
                    .with_pos(screen_pos)
                    .with_scale(Vec2::splat(tile.size * zoom))
                    .with_layer(RenderLayer::Foreground) // Bridges on layer 3 (under paths which are VFX/4)
                    .with_sprite(sprite);

                ctx.scene.spawn(entity);
                self.tile_entities.push(id);
                bridges_created += 1;
            }
        }

        if bridges_created > 0 {
            web_sys::console::log_1(&format!(
                "Created {} auto-bridge entities",
                bridges_created
            ).into());
        }
    }

    /// Build WorldQuery for script execution
    fn build_world_query(&self) -> WorldQuery {
        let mut query = WorldQuery::new();
        for actor in self.composite_actors.values() {
            query.add_actor(actor.id, actor.position, actor.tag.clone());
        }
        query
    }

    /// Execute scripts for all actors with scripts
    fn run_scripts(&mut self, dt: f32) {
        let query = self.build_world_query();
        let mut commands_by_actor: Vec<(ActorId, Vec<ScriptCommand>)> = Vec::new();

        // Collect commands from scripts
        for actor in self.composite_actors.values() {
            if let Some(script_id) = actor.script_id {
                // Find script name from ID (simplified - use ID as name for now)
                let script_name = format!("script_{}", script_id.0);

                let ctx = ScriptContext::new(actor.id, actor.position, dt, query.clone());

                match self.scripts.run_update_with_context(&script_name, ctx) {
                    Ok(commands) => {
                        if !commands.is_empty() {
                            commands_by_actor.push((actor.id, commands));
                        }
                    }
                    Err(_) => {
                        // Script not found or error - silently skip
                    }
                }
            }
        }

        // Apply commands
        for (actor_id, commands) in commands_by_actor {
            if let Some(actor) = self.composite_actors.get_mut(&actor_id) {
                for cmd in commands {
                    match cmd {
                        ScriptCommand::MoveTo(target) => {
                            // Simple direct movement toward target
                            let dir = target - actor.position;
                            if dir.length_squared() > 1.0 {
                                actor.velocity = dir.normalize() * 100.0;
                                actor.animation_state = AnimationState::Walk;
                                actor.update_direction_from_velocity();
                            } else {
                                actor.velocity = Vec2::ZERO;
                                actor.animation_state = AnimationState::Idle;
                            }
                        }
                        ScriptCommand::Attack(_target_id) => {
                            actor.animation_state = AnimationState::MeleeAttack;
                        }
                        ScriptCommand::SetDirection(dir) => {
                            actor.direction = dir;
                        }
                        ScriptCommand::SetAnimation(anim) => {
                            actor.animation_state = anim;
                        }
                        ScriptCommand::SetVelocity(vel) => {
                            actor.velocity = vel;
                            if vel.length_squared() > 0.1 {
                                actor.update_direction_from_velocity();
                            }
                        }
                        ScriptCommand::PlaySound(_name) => {
                            // TODO: Trigger sound via ctx.play_sound()
                        }
                    }
                }
            }
        }
    }

    /// Update actor positions based on velocity
    fn update_physics(&mut self, dt: f32) {
        for actor in self.composite_actors.values_mut() {
            actor.position += actor.velocity * dt;

            // Update animation timer
            actor.animation_timer += dt;
            let frame_duration = 0.1; // TODO: Get from manifest
            if actor.animation_timer >= frame_duration {
                actor.animation_timer -= frame_duration;
                actor.animation_frame += 1;
            }
        }
    }

    /// Handle player input for controlled actor
    fn handle_player_input(&mut self, _dt: f32) {
        let speed = 200.0;
        let mut movement = Vec2::ZERO;

        if self.input.key_held("ArrowRight") || self.input.key_held("d") {
            movement.x += 1.0;
        }
        if self.input.key_held("ArrowLeft") || self.input.key_held("a") {
            movement.x -= 1.0;
        }
        if self.input.key_held("ArrowUp") || self.input.key_held("w") {
            movement.y -= 1.0;
        }
        if self.input.key_held("ArrowDown") || self.input.key_held("s") {
            movement.y += 1.0;
        }

        // Normalize and apply speed
        if movement.length_squared() > 0.0 {
            movement = movement.normalize() * speed;
        }

        // Apply to player actor
        for actor in self.composite_actors.values_mut() {
            if actor.tag == "player" {
                actor.velocity = movement;
                if movement.length_squared() > 0.1 {
                    actor.animation_state = AnimationState::Walk;
                    actor.update_direction_from_velocity();
                } else {
                    actor.animation_state = AnimationState::Idle;
                }
            }
        }
    }
}

impl Default for ZapSquadGame {
    fn default() -> Self {
        Self::new()
    }
}

impl Game for ZapSquadGame {
    fn config(&self) -> GameConfig {
        GameConfig {
            world_width: 800.0,
            world_height: 600.0,
            fixed_dt: 1.0 / 60.0,
            max_entities: 10000,
            max_instances: 10000,
            ..Default::default()
        }
    }

    fn init(&mut self, _ctx: &mut EngineContext) {
        // Don't spawn test actor - wait for level to load
        web_sys::console::log_1(&"ZapSquad initialized".into());
    }

    fn update(&mut self, ctx: &mut EngineContext, input: &InputQueue) {
        let dt = 1.0 / 60.0;
        self.time += dt;

        // Process input events (including custom events from React)
        for event in input.iter() {
            if let InputEvent::Custom { kind, a, b, c } = event {
                self.handle_custom_event(*kind, *a, *b, *c);
            }
        }

        // Process pending reloads (scripts, manifests, levels)
        let (pending_manifest, level_loaded) = self.process_pending_reloads();

        let mut spawn_needed = level_loaded;

        if let Some(sprite_manifest) = pending_manifest {
            // Apply new sprite manifest to EngineContext
            match ctx.load_manifest(&sprite_manifest) {
                Ok(_) => {
                    web_sys::console::log_1(&"Sprite manifest loaded into engine".into());
                    spawn_needed = true;
                }
                Err(e) => {
                    web_sys::console::error_1(&format!("Failed to parse sprite manifest: {}", e).into());
                }
            }
        }

        // Re-spawn tiles when camera moves (for viewport culling)
        if self.camera_dirty && !self.tiles.is_empty() {
            spawn_needed = true;
            self.camera_dirty = false;
        }

        if spawn_needed {
            self.spawn_tile_entities(ctx);
        }

        // 1. Process Input
        self.handle_player_input(dt);

        // 2. Run Scripts
        self.run_scripts(dt);

        // 3. Update Physics & Animation
        self.update_physics(dt);

        // 4. Sync Composite Actors to Engine Entities
        // Transform actor positions from world to screen coordinates
        let camera_offset = Vec2::new(self.camera_x, self.camera_y);
        let zoom = self.camera_zoom;

        // Set scale to include zoom (base size 128 * zoom)
        self.composite_renderer.set_default_scale(128.0 * zoom);

        let actors: Vec<_> = self.composite_actors.values()
            .map(|actor| {
                let mut a = actor.clone();
                a.position = (a.position - camera_offset) * zoom;
                a
            })
            .collect();
        self.composite_renderer.sync_composites(ctx, actors.iter());
    }

    fn render(&self, _ctx: &mut RenderContext) {
        // Rendering handled by gateway/composite_renderer in update
    }
}

impl ZapSquadGame {
    /// Handle custom events from React
    fn handle_custom_event(&mut self, kind: u32, a: f32, b: f32, c: f32) {
        match kind {
            events::RELOAD_SCRIPTS => {
                // Scripts are passed via a separate mechanism (string data)
            }
            events::RELOAD_MANIFEST => {
                // Manifest is passed via reload_game_manifest
            }
            events::LOAD_LEVEL => {
                // Level is passed via load_level
            }
            events::SPAWN_ACTOR => {
                let x = a;
                let y = b;
                let _actor_type = c as u32;
                self.spawn_composite(Vec2::new(x, y), "soldier", "enemy");
            }
            // Camera position update: a=camX, b=camY, c=zoom
            100 => {
                let new_x = a;
                let new_y = b;
                let new_zoom = c;
                // Mark dirty if camera moved significantly
                if (self.camera_x - new_x).abs() > 1.0
                    || (self.camera_y - new_y).abs() > 1.0
                    || (self.camera_zoom - new_zoom).abs() > 0.01
                {
                    web_sys::console::log_1(&format!(
                        "[Camera] pos=({:.1}, {:.1}) zoom={:.2}",
                        new_x, new_y, new_zoom
                    ).into());
                    self.camera_x = new_x;
                    self.camera_y = new_y;
                    self.camera_zoom = new_zoom;
                    self.camera_dirty = true;
                }
            }
            // Viewport size update: a=width, b=height (in world coordinates)
            101 => {
                let new_w = a;
                let new_h = b;
                if (self.viewport_width - new_w).abs() > 1.0
                    || (self.viewport_height - new_h).abs() > 1.0
                {
                    web_sys::console::log_1(&format!(
                        "[Viewport] size=({:.1}, {:.1}) world units",
                        new_w, new_h
                    ).into());
                    self.viewport_width = new_w;
                    self.viewport_height = new_h;
                    self.camera_dirty = true;
                }
            }
            _ => {}
        }
    }
}

// Additional WASM exports for hot-reload
// Note: These use thread_local storage since we can't directly access the game instance
// The game checks these in its update loop

thread_local! {
    static PENDING_SCRIPTS: std::cell::RefCell<Option<HashMap<String, String>>> = std::cell::RefCell::new(None);
    static PENDING_GAME_MANIFEST: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);
    static PENDING_SPRITE_MANIFEST: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);
    static PENDING_LEVEL: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);
}

/// Reload Rhai scripts
/// Format: { "script_name": "source code", ... }
#[wasm_bindgen]
pub fn reload_scripts(scripts_json: &str) {
    if let Ok(scripts) = serde_json::from_str::<HashMap<String, String>>(scripts_json) {
        PENDING_SCRIPTS.with(|p| *p.borrow_mut() = Some(scripts.clone()));
    }
}

/// Reload game manifest (body/weapon definitions)
#[wasm_bindgen]
pub fn reload_game_manifest(manifest_json: &str) {
    PENDING_GAME_MANIFEST.with(|p| *p.borrow_mut() = Some(manifest_json.to_string()));
}

/// Reload sprite manifest (zap-engine atlas format)
#[wasm_bindgen]
pub fn reload_sprite_manifest(manifest_json: &str) {
    PENDING_SPRITE_MANIFEST.with(|p| *p.borrow_mut() = Some(manifest_json.to_string()));
}

/// Load an LDtk level
#[wasm_bindgen]
pub fn load_level(json: &str) {
    PENDING_LEVEL.with(|p| {
        *p.borrow_mut() = Some(json.to_string());
    });
}

/// Legacy alias for reload_game_manifest
#[wasm_bindgen]
pub fn reload_manifest(manifest_json: &str) {
    reload_game_manifest(manifest_json);
}

// Export the game using zap-web macro
zap_web::export_game!(ZapSquadGame, "zapsquad");
