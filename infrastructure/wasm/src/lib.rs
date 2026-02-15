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
    AssetGateway, AssetManifest, CompositeRenderer, EngineGateway, InputAdapter,
    InputEvent as AdapterInputEvent, ScriptCommand, ScriptContext, ScriptEngine, WorldQuery,
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

    // Adapters
    gateway: EngineGateway,
    composite_renderer: CompositeRenderer,
    input: InputAdapter,
    scripts: ScriptEngine,

    // Timing
    time: f32,

    // Pending reload data (set via custom events, processed in update)
    pending_scripts: Option<HashMap<String, String>>,
    pending_manifest: Option<String>,
    pending_level: Option<String>,
}

impl ZapSquadGame {
    pub fn new() -> Self {
        Self {
            state: GameState::new(),
            composite_actors: HashMap::new(),
            next_actor_id: 1,
            gateway: EngineGateway::new(),
            composite_renderer: CompositeRenderer::default(),
            input: InputAdapter::new(),
            scripts: ScriptEngine::new(),
            time: 0.0,
            pending_scripts: None,
            pending_manifest: None,
            pending_level: None,
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

    /// Process pending hot-reload data
    fn process_pending_reloads(&mut self) {
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

        // Reload manifest
        if let Some(manifest_json) = self.pending_manifest.take() {
            match AssetManifest::from_json(&manifest_json) {
                Ok(manifest) => {
                    self.composite_renderer.reload_manifest(manifest);
                    web_sys::console::log_1(&"Manifest reloaded".into());
                }
                Err(e) => {
                    web_sys::console::error_1(&format!("Failed to parse manifest: {:?}", e).into());
                }
            }
        }

        // Load level
        if let Some(level_json) = self.pending_level.take() {
            self.load_level_from_json(&level_json);
        }
    }

    /// Load level from LDtk JSON
    fn load_level_from_json(&mut self, json: &str) {
        // Clear existing actors
        self.composite_actors.clear();

        // Try to find level name - use first level if not specified
        let level_names = match AssetGateway::list_levels(json) {
            Ok(names) => names,
            Err(e) => {
                web_sys::console::error_1(&format!("Failed to list levels: {}", e).into());
                // Fallback to test actor
                self.spawn_composite(Vec2::new(400.0, 300.0), "soldier", "player");
                return;
            }
        };

        let level_name = level_names.first().cloned().unwrap_or_else(|| "Level_0".to_string());

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
                    &format!("Level '{}' loaded with {} actors", level_name, self.composite_actors.len()).into()
                );
            }
            Err(e) => {
                web_sys::console::error_1(&format!("Failed to load level: {}", e).into());
                // Fallback to test actor
                self.spawn_composite(Vec2::new(400.0, 300.0), "soldier", "player");
            }
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
            ..Default::default()
        }
    }

    fn init(&mut self, _ctx: &mut EngineContext) {
        // Spawn initial test actor
        self.spawn_composite(Vec2::new(400.0, 300.0), "soldier", "player");

        web_sys::console::log_1(&"ZapSquad initialized".into());
    }

    fn update(&mut self, ctx: &mut EngineContext, input: &InputQueue) {
        let dt = 1.0 / 60.0;
        self.time += dt;

        // Process any pending hot-reloads
        self.process_pending_reloads();

        // Process zap-engine input events
        for event in input.iter() {
            match event {
                InputEvent::PointerDown { x, y, .. } => {
                    self.input.process_event(AdapterInputEvent::PointerDown {
                        position: Vec2::new(*x, *y),
                        button: 0,
                    });
                }
                InputEvent::PointerUp { x, y, .. } => {
                    self.input.process_event(AdapterInputEvent::PointerUp {
                        position: Vec2::new(*x, *y),
                        button: 0,
                    });
                }
                InputEvent::PointerMove { x, y, .. } => {
                    self.input.process_event(AdapterInputEvent::PointerMove {
                        position: Vec2::new(*x, *y),
                    });
                }
                InputEvent::KeyDown { key_code } => {
                    if let Some(key) = key_code_to_name(*key_code) {
                        self.input.process_event(AdapterInputEvent::KeyDown { key });
                    }
                }
                InputEvent::KeyUp { key_code } => {
                    if let Some(key) = key_code_to_name(*key_code) {
                        self.input.process_event(AdapterInputEvent::KeyUp { key });
                    }
                }
                InputEvent::Custom { kind, a, b, c } => {
                    self.handle_custom_event(*kind, *a, *b, *c);
                }
            }
        }

        // Handle player input
        self.handle_player_input(dt);

        // Run scripts for NPCs
        self.run_scripts(dt);

        // Update physics/positions
        self.update_physics(dt);

        // Sync composite actors to renderer
        self.composite_renderer.sync_composites(
            ctx,
            self.composite_actors.values(),
        );

        // Also sync simple actors for backwards compatibility
        let render_requests: Vec<RenderRequest> = self
            .state
            .actors()
            .map(|actor| RenderRequest {
                actor_id: actor.id,
                position: actor.position,
                sprite_name: None,
                scale: 32.0,
                rotation: 0.0,
            })
            .collect();

        self.gateway.sync_actors(ctx, render_requests.into_iter());

        // End input frame
        self.input.end_frame();
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
                // This event just triggers the reload
                web_sys::console::log_1(&"Script reload triggered".into());
            }
            events::RELOAD_MANIFEST => {
                web_sys::console::log_1(&"Manifest reload triggered".into());
            }
            events::LOAD_LEVEL => {
                web_sys::console::log_1(&format!("Load level triggered: {}", a as u32).into());
            }
            events::SPAWN_ACTOR => {
                let x = a;
                let y = b;
                let _actor_type = c as u32;
                self.spawn_composite(Vec2::new(x, y), "soldier", "enemy");
            }
            _ => {}
        }
    }
}

// Additional WASM exports for hot-reload
#[wasm_bindgen]
pub fn reload_scripts(scripts_json: &str) {
    // Parse scripts JSON and store for processing
    // Format: { "script_name": "source code", ... }
    if let Ok(scripts) = serde_json::from_str::<HashMap<String, String>>(scripts_json) {
        // Store in a thread-local or pass via custom event
        web_sys::console::log_1(&format!("Received {} scripts for reload", scripts.len()).into());
        // Note: Actual reload happens in game update loop
    }
}

#[wasm_bindgen]
pub fn reload_manifest(manifest_json: &str) {
    web_sys::console::log_1(&format!("Received manifest: {} bytes", manifest_json.len()).into());
    // Note: Actual reload happens in game update loop
}

#[wasm_bindgen]
pub fn load_level(level_json: &str) {
    web_sys::console::log_1(&format!("Received level: {} bytes", level_json.len()).into());
    // Note: Actual load happens in game update loop
}

// Export the game using zap-web macro
zap_web::export_game!(ZapSquadGame, "zapsquad");
