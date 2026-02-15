//! Script entity - definitions for Rhai scripts

use serde::{Deserialize, Serialize};

/// Unique identifier for a script
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ScriptId(pub u32);

/// A script that can be attached to actors
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    pub id: ScriptId,
    pub name: String,
    pub source: String,
}

impl Script {
    pub fn new(id: ScriptId, name: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            id,
            name: name.into(),
            source: source.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_creation() {
        let script = Script::new(
            ScriptId(1),
            "player",
            "fn on_update(e, dt) { e.move_by(10.0, 0.0); }",
        );
        assert_eq!(script.id, ScriptId(1));
        assert_eq!(script.name, "player");
        assert!(script.source.contains("on_update"));
    }
}
