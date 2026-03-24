//! ZapSquad Adapters - Interface Layer
//!
//! This crate bridges core business logic with external systems:
//! - EngineGateway: Translates core render requests to zap-engine calls
//! - CompositeRenderer: Manages multi-entity composites for X-COM style characters
//! - InputAdapter: Converts platform input to core InputEvent DTOs
//! - ScriptBindings: Exposes core functionality to Rhai scripts
//! - AssetGateway: Loads assets and converts to core DTOs
//! - AssetManifest: Definitions for bodies, weapons, and other assets

pub mod asset_gateway;
pub mod asset_manifest;
pub mod composite_renderer;
pub mod engine_gateway;
pub mod input_adapter;
pub mod script_bindings;
pub mod game_script_bindings;

pub use asset_gateway::{AssetGateway, EntitySpawnInfo, TileDefinition, TileInstance};
pub use asset_manifest::{AssetManifest, BodyDefinition, WeaponDefinition, WeaponType};
pub use composite_renderer::CompositeRenderer;
pub use engine_gateway::EngineGateway;
pub use input_adapter::{InputAdapter, InputEvent};
pub use script_bindings::{ScriptCommand, ScriptContext, ScriptEngine, WorldQuery};
pub use game_script_bindings::{
    CharacterAiContext, RulesContext, WorldGenContext,
    AiCommand, RulesCommand, WorldGenCommand,
    GameView, CharacterView, TeamView,
    RulesScriptEngine,
};
