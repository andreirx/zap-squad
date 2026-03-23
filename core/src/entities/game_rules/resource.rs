//! Resource definitions and runtime state.
//!
//! Resources are per-team named quantities (gold, minerals, supply, etc.).
//! The schema is defined per game mode. Map objects can produce resources.

use serde::{Deserialize, Serialize};

/// A resource type definition (from game definition).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceDef {
    /// Key used in HashMap lookups (e.g., "gold", "minerals").
    pub key: String,
    /// Display name (e.g., "Gold", "Minerals").
    pub display_name: String,
    /// Starting amount per team.
    pub starting_amount: f32,
    /// Maximum amount (-1 for unlimited).
    pub max_amount: f32,
    /// Optional object ID that represents this resource on the map
    /// (e.g., a mineral patch, a gold mine).
    pub map_object_id: Option<String>,
    /// Resource icon/sprite for UI display.
    pub icon_id: Option<String>,
}

impl ResourceDef {
    pub fn new(key: impl Into<String>, display_name: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            display_name: display_name.into(),
            starting_amount: 0.0,
            max_amount: -1.0,
            map_object_id: None,
            icon_id: None,
        }
    }

    pub fn with_start(mut self, amount: f32) -> Self {
        self.starting_amount = amount;
        self
    }

    pub fn with_max(mut self, max: f32) -> Self {
        self.max_amount = max;
        self
    }

    pub fn with_map_object(mut self, id: impl Into<String>) -> Self {
        self.map_object_id = Some(id.into());
        self
    }
}

/// The full resource schema for a game mode.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResourceSchema {
    pub resources: Vec<ResourceDef>,
}

impl ResourceSchema {
    pub fn new() -> Self {
        Self { resources: Vec::new() }
    }

    pub fn add(mut self, resource: ResourceDef) -> Self {
        self.resources.push(resource);
        self
    }

    /// Create starting resources HashMap from schema.
    pub fn starting_resources(&self) -> super::types::Stats {
        self.resources.iter().map(|r| (r.key.clone(), r.starting_amount)).collect()
    }

    pub fn has(&self, key: &str) -> bool {
        self.resources.iter().any(|r| r.key == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_schema() {
        let schema = ResourceSchema::new()
            .add(ResourceDef::new("gold", "Gold").with_start(500.0))
            .add(ResourceDef::new("supply", "Supply").with_start(10.0).with_max(200.0));

        let resources = schema.starting_resources();
        assert_eq!(resources["gold"], 500.0);
        assert_eq!(resources["supply"], 10.0);
    }
}
