//! Composite Actor - X-COM style layered character entity
//!
//! A CompositeActor represents a character with multiple visual layers:
//! - Body: The character's body sprite (direction × animation × visual state)
//! - Weapon: Optional equipped weapon sprite (direction × animation)
//! - Throwable: Optional projectile sprite (when throwing)
//!
//! The rendering layer (adapters/) is responsible for spawning multiple
//! engine entities to represent each layer.

use glam::Vec2;
use serde::{Deserialize, Serialize};

use super::{ActorId, ScriptId};

/// Cardinal direction the actor is facing
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum Direction {
    North,
    East,
    #[default]
    South,
    West,
}

impl Direction {
    /// Derive direction from a velocity vector
    pub fn from_velocity(velocity: Vec2) -> Option<Self> {
        if velocity.length_squared() < 0.001 {
            return None;
        }

        // Determine primary axis
        if velocity.x.abs() > velocity.y.abs() {
            if velocity.x > 0.0 {
                Some(Direction::East)
            } else {
                Some(Direction::West)
            }
        } else if velocity.y > 0.0 {
            Some(Direction::South) // +Y is down in screen space
        } else {
            Some(Direction::North)
        }
    }

    /// Convert to angle in radians (for rotation)
    pub fn to_radians(self) -> f32 {
        match self {
            Direction::North => -std::f32::consts::FRAC_PI_2,
            Direction::East => 0.0,
            Direction::South => std::f32::consts::FRAC_PI_2,
            Direction::West => std::f32::consts::PI,
        }
    }

    /// Get unit vector for this direction
    pub fn to_vec2(self) -> Vec2 {
        match self {
            Direction::North => Vec2::new(0.0, -1.0),
            Direction::East => Vec2::new(1.0, 0.0),
            Direction::South => Vec2::new(0.0, 1.0),
            Direction::West => Vec2::new(-1.0, 0.0),
        }
    }
}

/// Animation state for sprite selection
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum AnimationState {
    #[default]
    Idle,
    Walk,
    MeleeAttack,
    ThrowAttack,
}

impl AnimationState {
    /// Get the string identifier used in sprite naming
    pub fn as_str(&self) -> &'static str {
        match self {
            AnimationState::Idle => "idle",
            AnimationState::Walk => "walk",
            AnimationState::MeleeAttack => "melee_attack",
            AnimationState::ThrowAttack => "throw_attack",
        }
    }
}

/// Visual state based on health (damage indicators)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum VisualState {
    #[default]
    Full,    // 75-100% health
    Hurt1,   // 50-75% health
    Hurt2,   // 25-50% health
    Critical, // 0-25% health
}

impl VisualState {
    /// Derive visual state from health percentage
    pub fn from_health(current: i32, max: i32) -> Self {
        if max <= 0 {
            return VisualState::Full;
        }

        let pct = (current as f32 / max as f32) * 100.0;

        if pct > 75.0 {
            VisualState::Full
        } else if pct > 50.0 {
            VisualState::Hurt1
        } else if pct > 25.0 {
            VisualState::Hurt2
        } else {
            VisualState::Critical
        }
    }

    /// Get the string identifier used in sprite naming
    pub fn as_str(&self) -> &'static str {
        match self {
            VisualState::Full => "full",
            VisualState::Hurt1 => "hurt_1",
            VisualState::Hurt2 => "hurt_2",
            VisualState::Critical => "critical",
        }
    }
}

/// A composite actor with multiple visual layers (X-COM style)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompositeActor {
    pub id: ActorId,
    pub position: Vec2,
    pub velocity: Vec2,
    pub direction: Direction,
    pub animation_state: AnimationState,

    // Asset references (definition IDs, not sprites)
    pub body_def_id: String,
    pub weapon_def_id: Option<String>,
    pub throwable_def_id: Option<String>,

    // Health and visual state
    pub health: i32,
    pub max_health: i32,

    // Gameplay
    pub script_id: Option<ScriptId>,
    pub tag: String,

    // Animation timing
    pub animation_frame: u32,
    pub animation_timer: f32,
}

impl CompositeActor {
    pub fn new(id: ActorId, position: Vec2, body_def_id: impl Into<String>) -> Self {
        Self {
            id,
            position,
            velocity: Vec2::ZERO,
            direction: Direction::South,
            animation_state: AnimationState::Idle,
            body_def_id: body_def_id.into(),
            weapon_def_id: None,
            throwable_def_id: None,
            health: 100,
            max_health: 100,
            script_id: None,
            tag: String::new(),
            animation_frame: 0,
            animation_timer: 0.0,
        }
    }

    /// Builder: set weapon
    pub fn with_weapon(mut self, weapon_def_id: impl Into<String>) -> Self {
        self.weapon_def_id = Some(weapon_def_id.into());
        self
    }

    /// Builder: set health
    pub fn with_health(mut self, current: i32, max: i32) -> Self {
        self.health = current;
        self.max_health = max;
        self
    }

    /// Builder: set script
    pub fn with_script(mut self, script_id: ScriptId) -> Self {
        self.script_id = Some(script_id);
        self
    }

    /// Builder: set tag
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tag = tag.into();
        self
    }

    /// Get current visual state based on health
    pub fn visual_state(&self) -> VisualState {
        VisualState::from_health(self.health, self.max_health)
    }

    /// Update direction from current velocity (if moving)
    pub fn update_direction_from_velocity(&mut self) {
        if let Some(dir) = Direction::from_velocity(self.velocity) {
            self.direction = dir;
        }
    }

    /// Take damage and return whether actor is still alive
    pub fn take_damage(&mut self, amount: i32) -> bool {
        self.health = (self.health - amount).max(0);
        self.health > 0
    }

    /// Heal the actor
    pub fn heal(&mut self, amount: i32) {
        self.health = (self.health + amount).min(self.max_health);
    }

    /// Check if actor is alive
    pub fn is_alive(&self) -> bool {
        self.health > 0
    }

    /// Generate sprite key for body layer: "{visual}_{anim}_{direction}"
    pub fn body_sprite_key(&self) -> String {
        format!(
            "{}_{}_{}",
            self.visual_state().as_str(),
            self.animation_state.as_str(),
            direction_suffix(self.direction)
        )
    }

    /// Generate sprite key for weapon layer: "{anim}_{direction}"
    pub fn weapon_sprite_key(&self) -> String {
        format!(
            "{}_{}",
            self.animation_state.as_str(),
            direction_suffix(self.direction)
        )
    }
}

/// Convert direction to sprite suffix
fn direction_suffix(dir: Direction) -> &'static str {
    match dir {
        Direction::North => "up",
        Direction::East => "right",
        Direction::South => "down",
        Direction::West => "left",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_from_velocity() {
        assert_eq!(
            Direction::from_velocity(Vec2::new(1.0, 0.0)),
            Some(Direction::East)
        );
        assert_eq!(
            Direction::from_velocity(Vec2::new(-1.0, 0.0)),
            Some(Direction::West)
        );
        assert_eq!(
            Direction::from_velocity(Vec2::new(0.0, 1.0)),
            Some(Direction::South)
        );
        assert_eq!(
            Direction::from_velocity(Vec2::new(0.0, -1.0)),
            Some(Direction::North)
        );
        assert_eq!(Direction::from_velocity(Vec2::ZERO), None);
    }

    #[test]
    fn visual_state_from_health() {
        assert_eq!(VisualState::from_health(100, 100), VisualState::Full);
        assert_eq!(VisualState::from_health(76, 100), VisualState::Full);
        assert_eq!(VisualState::from_health(75, 100), VisualState::Hurt1);
        assert_eq!(VisualState::from_health(51, 100), VisualState::Hurt1);
        assert_eq!(VisualState::from_health(50, 100), VisualState::Hurt2);
        assert_eq!(VisualState::from_health(26, 100), VisualState::Hurt2);
        assert_eq!(VisualState::from_health(25, 100), VisualState::Critical);
        assert_eq!(VisualState::from_health(0, 100), VisualState::Critical);
    }

    #[test]
    fn composite_actor_creation() {
        let actor = CompositeActor::new(ActorId(1), Vec2::new(100.0, 200.0), "soldier");

        assert_eq!(actor.id, ActorId(1));
        assert_eq!(actor.position, Vec2::new(100.0, 200.0));
        assert_eq!(actor.body_def_id, "soldier");
        assert_eq!(actor.direction, Direction::South);
        assert_eq!(actor.animation_state, AnimationState::Idle);
        assert_eq!(actor.visual_state(), VisualState::Full);
    }

    #[test]
    fn composite_actor_with_weapon() {
        let actor = CompositeActor::new(ActorId(1), Vec2::ZERO, "soldier").with_weapon("rifle");

        assert_eq!(actor.weapon_def_id, Some("rifle".to_string()));
    }

    #[test]
    fn composite_actor_damage() {
        let mut actor =
            CompositeActor::new(ActorId(1), Vec2::ZERO, "soldier").with_health(100, 100);

        assert!(actor.is_alive());
        assert_eq!(actor.visual_state(), VisualState::Full);

        actor.take_damage(30);
        assert_eq!(actor.health, 70);
        assert_eq!(actor.visual_state(), VisualState::Hurt1);

        actor.take_damage(30);
        assert_eq!(actor.health, 40);
        assert_eq!(actor.visual_state(), VisualState::Hurt2);

        actor.take_damage(30);
        assert_eq!(actor.health, 10);
        assert_eq!(actor.visual_state(), VisualState::Critical);

        let alive = actor.take_damage(20);
        assert!(!alive);
        assert!(!actor.is_alive());
    }

    #[test]
    fn body_sprite_key_generation() {
        let mut actor = CompositeActor::new(ActorId(1), Vec2::ZERO, "soldier");

        // Default: full health, idle, facing south
        assert_eq!(actor.body_sprite_key(), "full_idle_down");

        // Walking east
        actor.direction = Direction::East;
        actor.animation_state = AnimationState::Walk;
        assert_eq!(actor.body_sprite_key(), "full_walk_right");

        // Hurt, attacking north
        actor.health = 50;
        actor.direction = Direction::North;
        actor.animation_state = AnimationState::MeleeAttack;
        assert_eq!(actor.body_sprite_key(), "hurt_2_melee_attack_up");
    }

    #[test]
    fn weapon_sprite_key_generation() {
        let mut actor =
            CompositeActor::new(ActorId(1), Vec2::ZERO, "soldier").with_weapon("sword");

        actor.direction = Direction::West;
        actor.animation_state = AnimationState::MeleeAttack;
        assert_eq!(actor.weapon_sprite_key(), "melee_attack_left");
    }

    #[test]
    fn update_direction_from_velocity() {
        let mut actor = CompositeActor::new(ActorId(1), Vec2::ZERO, "soldier");

        actor.velocity = Vec2::new(5.0, 0.0);
        actor.update_direction_from_velocity();
        assert_eq!(actor.direction, Direction::East);

        actor.velocity = Vec2::new(0.0, -5.0);
        actor.update_direction_from_velocity();
        assert_eq!(actor.direction, Direction::North);

        // Zero velocity should not change direction
        let prev_dir = actor.direction;
        actor.velocity = Vec2::ZERO;
        actor.update_direction_from_velocity();
        assert_eq!(actor.direction, prev_dir);
    }
}
