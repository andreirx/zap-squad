//! Composite Renderer - Manages multiple zap-engine entities per CompositeActor
//!
//! Since zap-engine's Fat Entity model has one sprite per entity, we need to
//! spawn multiple entities to render layered characters (body + weapon + throwable).
//! This module handles spawning, syncing, and despawning those entity groups.

use glam::Vec2;
use std::collections::HashMap;
use zap_engine::{Entity, EntityId, EngineContext, RenderLayer, SpriteComponent};
use zapsquad_core::{ActorId, CompositeActor};

use crate::asset_manifest::AssetManifest;

/// Tracks zap-engine entities for a single CompositeActor
#[derive(Debug, Clone)]
struct CompositeEntities {
    body: EntityId,
    weapon: Option<EntityId>,
    throwable: Option<EntityId>,
}

/// Manages rendering of CompositeActors as multiple zap-engine entities
pub struct CompositeRenderer {
    /// Maps ActorId to its zap-engine entities
    entities: HashMap<ActorId, CompositeEntities>,
    /// Asset definitions for sprite resolution
    manifest: AssetManifest,
    /// Default scale for entities
    default_scale: f32,
}

impl CompositeRenderer {
    pub fn new(manifest: AssetManifest) -> Self {
        Self {
            entities: HashMap::new(),
            manifest,
            default_scale: 128.0, // Match tile size for consistent rendering
        }
    }

    /// Replace the manifest (for hot-reload)
    pub fn reload_manifest(&mut self, manifest: AssetManifest) {
        self.manifest = manifest;
    }

    /// Get current manifest reference
    pub fn manifest(&self) -> &AssetManifest {
        &self.manifest
    }

    /// Set default scale for new entities
    pub fn set_default_scale(&mut self, scale: f32) {
        self.default_scale = scale;
    }

    /// Sync all composite actors to zap-engine scene
    pub fn sync_composites<'a>(
        &mut self,
        ctx: &mut EngineContext,
        actors: impl Iterator<Item = &'a CompositeActor>,
    ) {
        let mut seen_ids = Vec::new();

        for actor in actors {
            seen_ids.push(actor.id);

            if let Some(composite) = self.entities.get(&actor.id) {
                // Update existing entities
                self.update_composite(ctx, actor, composite.clone());
            } else {
                // Spawn new entities
                self.spawn_composite(ctx, actor);
            }
        }

        // Despawn entities for removed actors
        let to_remove: Vec<ActorId> = self
            .entities
            .keys()
            .filter(|id| !seen_ids.contains(id))
            .copied()
            .collect();

        for id in to_remove {
            self.despawn_composite(ctx, id);
        }
    }

    /// Spawn entities for a new CompositeActor
    fn spawn_composite(&mut self, ctx: &mut EngineContext, actor: &CompositeActor) {
        // Spawn body entity
        let body_id = ctx.next_id();
        let body = self.create_body_entity(body_id, actor);
        ctx.scene.spawn(body);

        // Spawn weapon entity if equipped
        let weapon = if actor.weapon_def_id.is_some() {
            let weapon_id = ctx.next_id();
            let weapon_pos = self.calculate_weapon_position(actor);
            let weapon = self.create_weapon_entity(weapon_id, weapon_pos);
            ctx.scene.spawn(weapon);
            Some(weapon_id)
        } else {
            None
        };

        // Store mapping
        self.entities.insert(
            actor.id,
            CompositeEntities {
                body: body_id,
                weapon,
                throwable: None,
            },
        );
    }

    /// Update existing entities for an actor
    fn update_composite(
        &mut self,
        ctx: &mut EngineContext,
        actor: &CompositeActor,
        mut composite: CompositeEntities,
    ) {
        // Resolve sprites before mutably borrowing scene
        let body_sprite = self.resolve_body_sprite(ctx, actor);
        let weapon_sprite = self.resolve_weapon_sprite(ctx, actor);
        let weapon_pos = self.calculate_weapon_position(actor);

        // Update body
        if let Some(body) = ctx.scene.get_mut(composite.body) {
            body.pos = actor.position;
            body.scale = Vec2::splat(self.default_scale); // Apply zoom
            if let Some(sprite) = body_sprite {
                body.sprite = Some(sprite);
            }
        }

        // Handle weapon spawn/despawn/update
        match (&actor.weapon_def_id, composite.weapon) {
            (Some(_), Some(weapon_id)) => {
                // Update existing weapon
                if let Some(weapon) = ctx.scene.get_mut(weapon_id) {
                    weapon.pos = weapon_pos;
                    weapon.scale = Vec2::splat(self.default_scale); // Apply zoom
                    if let Some(sprite) = weapon_sprite {
                        weapon.sprite = Some(sprite);
                    }
                }
            }
            (Some(_), None) => {
                // Spawn new weapon
                let weapon_id = ctx.next_id();
                let weapon = self.create_weapon_entity(weapon_id, weapon_pos);
                ctx.scene.spawn(weapon);
                composite.weapon = Some(weapon_id);
                self.entities.insert(actor.id, composite);
            }
            (None, Some(weapon_id)) => {
                // Despawn weapon
                ctx.despawn(weapon_id);
                composite.weapon = None;
                self.entities.insert(actor.id, composite);
            }
            (None, None) => {
                // No weapon, nothing to do
            }
        }
    }

    /// Despawn all entities for an actor
    fn despawn_composite(&mut self, ctx: &mut EngineContext, actor_id: ActorId) {
        if let Some(composite) = self.entities.remove(&actor_id) {
            ctx.despawn(composite.body);
            if let Some(weapon_id) = composite.weapon {
                ctx.despawn(weapon_id);
            }
            if let Some(throwable_id) = composite.throwable {
                ctx.despawn(throwable_id);
            }
        }
    }

    /// Create body entity
    fn create_body_entity(&self, id: EntityId, actor: &CompositeActor) -> Entity {
        Entity::new(id)
            .with_pos(actor.position)
            .with_scale(Vec2::splat(self.default_scale))
            .with_layer(RenderLayer::UI) // Layer 5: above all tiles including paths
    }

    /// Create weapon entity
    fn create_weapon_entity(&self, id: EntityId, pos: Vec2) -> Entity {
        Entity::new(id)
            .with_pos(pos)
            .with_scale(Vec2::splat(self.default_scale))
            .with_layer(RenderLayer::UI) // Same layer as body
    }

    /// Calculate weapon position from body anchor + weapon offset
    fn calculate_weapon_position(&self, actor: &CompositeActor) -> Vec2 {
        let body_anchor = self
            .manifest
            .get_body(&actor.body_def_id)
            .map(|b| b.weapon_anchor(actor.direction))
            .unwrap_or(Vec2::ZERO);

        let weapon_offset = actor
            .weapon_def_id
            .as_ref()
            .and_then(|id| self.manifest.get_weapon(id))
            .map(|w| w.offset(actor.direction))
            .unwrap_or(Vec2::ZERO);

        actor.position + body_anchor + weapon_offset
    }

    /// Resolve body sprite from registry
    fn resolve_body_sprite(
        &self,
        ctx: &EngineContext,
        actor: &CompositeActor,
    ) -> Option<SpriteComponent> {
        let body_def = self.manifest.get_body(&actor.body_def_id)?;
        let frame = actor.animation_frame % body_def.frames_per_state;
        let sprite_name = body_def.sprite_name(
            actor.direction,
            actor.animation_state,
            actor.visual_state(),
            frame,
        );
        ctx.sprite(&sprite_name)
    }

    /// Resolve weapon sprite from registry
    fn resolve_weapon_sprite(
        &self,
        ctx: &EngineContext,
        actor: &CompositeActor,
    ) -> Option<SpriteComponent> {
        let weapon_id = actor.weapon_def_id.as_ref()?;
        let weapon_def = self.manifest.get_weapon(weapon_id)?;
        let frame = actor.animation_frame % weapon_def.frames_per_state;
        let sprite_name = weapon_def.sprite_name(actor.direction, actor.animation_state, frame);
        ctx.sprite(&sprite_name)
    }

    /// Clear all entities
    pub fn clear(&mut self, ctx: &mut EngineContext) {
        for (_, composite) in self.entities.drain() {
            ctx.despawn(composite.body);
            if let Some(weapon_id) = composite.weapon {
                ctx.despawn(weapon_id);
            }
            if let Some(throwable_id) = composite.throwable {
                ctx.despawn(throwable_id);
            }
        }
    }

    /// Get entity count (for debugging)
    pub fn entity_count(&self) -> usize {
        self.entities.len()
    }
}

impl Default for CompositeRenderer {
    fn default() -> Self {
        Self::new(AssetManifest::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_manifest::BodyDefinition;
    use std::collections::HashMap;
    use zapsquad_core::Direction;

    fn test_manifest() -> AssetManifest {
        let mut manifest = AssetManifest::new();
        manifest.add_body(BodyDefinition {
            id: "soldier".to_string(),
            name: "Soldier".to_string(),
            frames_per_state: 4,
            frame_duration: 0.1,
            weapon_anchors: HashMap::new(),
        });
        manifest
    }

    #[test]
    fn composite_renderer_creation() {
        let manifest = test_manifest();
        let renderer = CompositeRenderer::new(manifest);
        assert_eq!(renderer.entity_count(), 0);
    }

    #[test]
    fn weapon_position_calculation() {
        use crate::asset_manifest::WeaponDefinition;

        let mut manifest = AssetManifest::new();

        let mut anchors = HashMap::new();
        anchors.insert("right".to_string(), Vec2::new(16.0, 8.0));

        manifest.add_body(BodyDefinition {
            id: "soldier".to_string(),
            name: "Soldier".to_string(),
            frames_per_state: 4,
            frame_duration: 0.1,
            weapon_anchors: anchors,
        });

        let mut offsets = HashMap::new();
        offsets.insert("right".to_string(), Vec2::new(4.0, 0.0));

        manifest.add_weapon(WeaponDefinition {
            id: "sword".to_string(),
            name: "Sword".to_string(),
            weapon_type: crate::asset_manifest::WeaponType::Melee,
            frames_per_state: 4,
            frame_duration: 0.1,
            offsets,
        });

        let renderer = CompositeRenderer::new(manifest);

        let mut actor = CompositeActor::new(ActorId(1), Vec2::new(100.0, 100.0), "soldier");
        actor.weapon_def_id = Some("sword".to_string());
        actor.direction = Direction::East;

        let weapon_pos = renderer.calculate_weapon_position(&actor);
        // 100 + 16 (anchor) + 4 (offset) = 120
        assert_eq!(weapon_pos.x, 120.0);
        // 100 + 8 (anchor) + 0 (offset) = 108
        assert_eq!(weapon_pos.y, 108.0);
    }
}
