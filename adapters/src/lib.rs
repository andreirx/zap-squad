//! ZapSquad Adapters - Interface Layer
//!
//! This crate bridges core business logic with external systems:
//! - EngineGateway: Translates core render requests to zap-engine calls
//! - InputAdapter: Converts platform input to core InputEvent DTOs
//! - ScriptBindings: Exposes core functionality to Rhai scripts
//! - AssetGateway: Loads assets and converts to core DTOs

pub mod engine_gateway;
pub mod input_adapter;
pub mod script_bindings;
pub mod asset_gateway;

pub use engine_gateway::EngineGateway;
pub use input_adapter::{InputAdapter, InputEvent};
pub use script_bindings::ScriptEngine;
pub use asset_gateway::AssetGateway;
