//! Actor entity - characters, NPCs, and interactive objects

use glam::Vec2;
use serde::{Deserialize, Serialize};

/// Unique identifier for an actor
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ActorId(pub u32);

/// An actor in the game world (player, NPC, enemy, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Actor {
    pub id: ActorId,
    pub position: Vec2,
    pub velocity: Vec2,
    pub tag: String,
    pub script_id: Option<ScriptId>,
}

use super::ScriptId;

impl Actor {
    pub fn new(id: ActorId, position: Vec2) -> Self {
        Self {
            id,
            position,
            velocity: Vec2::ZERO,
            tag: String::new(),
            script_id: None,
        }
    }

    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tag = tag.into();
        self
    }

    pub fn with_script(mut self, script_id: ScriptId) -> Self {
        self.script_id = Some(script_id);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_creation() {
        let actor = Actor::new(ActorId(1), Vec2::new(100.0, 200.0));
        assert_eq!(actor.id, ActorId(1));
        assert_eq!(actor.position, Vec2::new(100.0, 200.0));
        assert_eq!(actor.velocity, Vec2::ZERO);
    }

    #[test]
    fn actor_with_tag() {
        let actor = Actor::new(ActorId(1), Vec2::ZERO).with_tag("player");
        assert_eq!(actor.tag, "player");
    }
}
