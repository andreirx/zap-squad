//! ZapSquad WASM Entry Point
//!
//! This crate provides wasm-bindgen exports that bridge JavaScript
//! to the core/adapters layers.

use wasm_bindgen::prelude::*;
use glam::Vec2;

// Import all from zap_engine for the export_game macro (it uses InputEvent directly)
use zap_engine::*;

use zapsquad_core::GameState;
use zapsquad_adapters::{
    EngineGateway, InputAdapter,
    InputEvent as AdapterInputEvent,
    ScriptEngine,
    engine_gateway::RenderRequest,
};

/// Convert key code to key name
fn key_code_to_name(code: u32) -> Option<String> {
    // Standard key codes (from JS KeyboardEvent.keyCode)
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

/// Main game struct that implements zap-engine's Game trait
pub struct ZapSquadGame {
    state: GameState,
    gateway: EngineGateway,
    input: InputAdapter,
    scripts: ScriptEngine,
    time: f32,
}

impl ZapSquadGame {
    pub fn new() -> Self {
        Self {
            state: GameState::new(),
            gateway: EngineGateway::new(),
            input: InputAdapter::new(),
            scripts: ScriptEngine::new(),
            time: 0.0,
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
        // Spawn a test actor
        let id = self.state.spawn_actor(Vec2::new(400.0, 300.0));
        if let Some(actor) = self.state.get_actor_mut(id) {
            actor.tag = "player".to_string();
        }
    }

    fn update(&mut self, ctx: &mut EngineContext, input: &InputQueue) {
        self.time += 1.0 / 60.0;

        // Process zap-engine input and convert to our InputEvents
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
                _ => {}
            }
        }

        // Simple movement for player
        let speed = 200.0;
        let dt = 1.0 / 60.0;
        let mut movement = Vec2::ZERO;

        if self.input.key_held("ArrowRight") || self.input.key_held("d") {
            movement.x += speed * dt;
        }
        if self.input.key_held("ArrowLeft") || self.input.key_held("a") {
            movement.x -= speed * dt;
        }
        if self.input.key_held("ArrowUp") || self.input.key_held("w") {
            movement.y -= speed * dt;
        }
        if self.input.key_held("ArrowDown") || self.input.key_held("s") {
            movement.y += speed * dt;
        }

        // Apply movement to player
        let players = self.state.find_by_tag("player");
        if let Some(player) = players.first() {
            let player_id = player.id;
            if let Some(actor) = self.state.get_actor_mut(player_id) {
                actor.position += movement;
            }
        }

        // Sync actors to rendering
        let render_requests: Vec<RenderRequest> = self.state.actors()
            .map(|actor| RenderRequest {
                actor_id: actor.id,
                position: actor.position,
                sprite_name: None,
                scale: 32.0,
                rotation: 0.0,
            })
            .collect();

        self.gateway.sync_actors(ctx, render_requests.into_iter());

        // End frame for input
        self.input.end_frame();
    }

    fn render(&self, _ctx: &mut RenderContext) {
        // Rendering handled by gateway in update
    }
}

// Export the game using zap-web macro
zap_web::export_game!(ZapSquadGame, "zapsquad");
