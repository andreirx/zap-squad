//! Game Rules Domain — the core model for playable games.
//!
//! This module defines the entities that make a world into a game:
//! teams, resources, character stats, time models, game modes,
//! and the event system that connects them.
//!
//! All types are pure data — no framework dependencies, no side effects.
//! Game logic (damage formulas, resource ticking, turn advancement)
//! lives in Rhai scripts that operate on these types via the adapters layer.
//!
//! # Architecture
//!
//! ```text
//! Game Definition (JSON)
//!   ├── GameMode          — RTS / Tactical (KOTOR-style) / TurnBased
//!   ├── TeamDefinition[]  — who plays, human or CPU
//!   ├── StatSchema        — which stats exist (hp, ap, courage, psi...)
//!   ├── ResourceSchema    — which resources exist (gold, minerals, supply...)
//!   ├── CharacterTemplate[] — fungible unit types with base stats
//!   ├── ScriptRefs        — rules script, team AI scripts, world gen script
//!   └── WinConditions     — what ends the game
//!
//! Runtime State (owned by WASM game loop)
//!   ├── GameSession       — current phase, clock, active team
//!   ├── TeamState[]       — per-team resources, relations
//!   ├── CharacterInstance[]— individual characters with live stats
//!   └── EventQueue        — pending game events for script consumption
//! ```

mod types;
mod team;
mod character;
mod resource;
mod session;
mod event;
mod definition;
mod validation;
mod package;

pub use types::*;
pub use team::*;
pub use character::*;
pub use resource::*;
pub use session::*;
pub use event::*;
pub use definition::*;
pub use validation::*;
pub use package::*;
