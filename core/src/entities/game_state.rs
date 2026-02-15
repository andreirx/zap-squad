//! Game state entity - the current state of the game world

use super::{Actor, ActorId, Level};
use std::collections::HashMap;

/// The complete state of the game at any moment
#[derive(Debug, Default)]
pub struct GameState {
    actors: HashMap<ActorId, Actor>,
    next_actor_id: u32,
    pub current_level: Option<Level>,
    pub time: f32,
}

impl GameState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a new actor and return its ID
    pub fn spawn_actor(&mut self, position: glam::Vec2) -> ActorId {
        let id = ActorId(self.next_actor_id);
        self.next_actor_id += 1;
        let actor = Actor::new(id, position);
        self.actors.insert(id, actor);
        id
    }

    /// Get an actor by ID
    pub fn get_actor(&self, id: ActorId) -> Option<&Actor> {
        self.actors.get(&id)
    }

    /// Get a mutable reference to an actor
    pub fn get_actor_mut(&mut self, id: ActorId) -> Option<&mut Actor> {
        self.actors.get_mut(&id)
    }

    /// Remove an actor
    pub fn despawn_actor(&mut self, id: ActorId) -> Option<Actor> {
        self.actors.remove(&id)
    }

    /// Iterate over all actors
    pub fn actors(&self) -> impl Iterator<Item = &Actor> {
        self.actors.values()
    }

    /// Iterate over all actors mutably
    pub fn actors_mut(&mut self) -> impl Iterator<Item = &mut Actor> {
        self.actors.values_mut()
    }

    /// Find actors by tag
    pub fn find_by_tag(&self, tag: &str) -> Vec<&Actor> {
        self.actors.values().filter(|a| a.tag == tag).collect()
    }

    /// Count of actors
    pub fn actor_count(&self) -> usize {
        self.actors.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec2;

    #[test]
    fn spawn_and_get_actor() {
        let mut state = GameState::new();
        let id = state.spawn_actor(Vec2::new(10.0, 20.0));

        let actor = state.get_actor(id).unwrap();
        assert_eq!(actor.position, Vec2::new(10.0, 20.0));
    }

    #[test]
    fn despawn_actor() {
        let mut state = GameState::new();
        let id = state.spawn_actor(Vec2::ZERO);
        assert_eq!(state.actor_count(), 1);

        state.despawn_actor(id);
        assert_eq!(state.actor_count(), 0);
        assert!(state.get_actor(id).is_none());
    }

    #[test]
    fn find_by_tag() {
        let mut state = GameState::new();
        let id1 = state.spawn_actor(Vec2::ZERO);
        let id2 = state.spawn_actor(Vec2::ZERO);

        state.get_actor_mut(id1).unwrap().tag = "enemy".to_string();
        state.get_actor_mut(id2).unwrap().tag = "coin".to_string();

        let enemies = state.find_by_tag("enemy");
        assert_eq!(enemies.len(), 1);
        assert_eq!(enemies[0].id, id1);
    }
}
