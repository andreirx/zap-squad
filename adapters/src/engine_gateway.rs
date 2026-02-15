//! Engine Gateway - bridges core to zap-engine rendering
//!
//! The core layer requests rendering via simple DTOs.
//! This gateway translates those requests to zap-engine calls.

use glam::Vec2;
use zap_engine::{Entity, EngineContext, EntityId};
use zapsquad_core::ActorId;
use std::collections::HashMap;

/// Render request DTO from core
#[derive(Debug, Clone)]
pub struct RenderRequest {
    pub actor_id: ActorId,
    pub position: Vec2,
    pub sprite_name: Option<String>,
    pub scale: f32,
    pub rotation: f32,
}

/// Gateway that translates core render requests to zap-engine
pub struct EngineGateway {
    /// Maps ActorId to zap-engine EntityId
    entity_map: HashMap<ActorId, EntityId>,
}

impl EngineGateway {
    pub fn new() -> Self {
        Self {
            entity_map: HashMap::new(),
        }
    }

    /// Sync game state to zap-engine scene
    pub fn sync_actors(
        &mut self,
        ctx: &mut EngineContext,
        actors: impl Iterator<Item = RenderRequest>,
    ) {
        for req in actors {
            if let Some(&entity_id) = self.entity_map.get(&req.actor_id) {
                // Update existing entity
                if let Some(entity) = ctx.scene.get_mut(entity_id) {
                    entity.pos = req.position;
                    entity.rotation = req.rotation;
                    entity.scale = Vec2::splat(req.scale);
                }
            } else {
                // Spawn new entity
                let entity_id = ctx.next_id();
                let entity = Entity::new(entity_id)
                    .with_pos(req.position)
                    .with_scale(Vec2::splat(req.scale))
                    .with_rotation(req.rotation);

                ctx.scene.spawn(entity);
                self.entity_map.insert(req.actor_id, entity_id);
            }
        }
    }

    /// Remove an actor's entity from the scene
    pub fn despawn_actor(&mut self, ctx: &mut EngineContext, actor_id: ActorId) {
        if let Some(entity_id) = self.entity_map.remove(&actor_id) {
            ctx.despawn(entity_id);
        }
    }

    /// Clear all entities
    pub fn clear(&mut self, ctx: &mut EngineContext) {
        for (_, entity_id) in self.entity_map.drain() {
            ctx.despawn(entity_id);
        }
    }
}

impl Default for EngineGateway {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_request_creation() {
        let req = RenderRequest {
            actor_id: ActorId(1),
            position: Vec2::new(100.0, 200.0),
            sprite_name: Some("player".to_string()),
            scale: 32.0,
            rotation: 0.0,
        };
        assert_eq!(req.actor_id, ActorId(1));
        assert_eq!(req.position.x, 100.0);
    }
}
