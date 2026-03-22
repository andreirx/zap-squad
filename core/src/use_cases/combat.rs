//! Combat resolution use case.
//!
//! Pure business logic for damage calculation and application.
//! No framework dependencies, no side effects, fully deterministic.
//!
//! Design note: This is intentionally simple (flat damage, no RNG).
//! Combat complexity belongs in Rhai scripts that call these primitives.
//! The core provides reliable damage math; scripts provide game design.

use crate::entities::{ActorId, CompositeActor};

/// Result of applying damage to an actor.
#[derive(Debug, Clone)]
pub struct DamageResult {
    pub target_id: ActorId,
    pub damage_dealt: i32,
    pub new_health: i32,
    pub is_kill: bool,
}

/// Apply flat damage to a target actor.
///
/// Returns a DamageResult describing what happened. The caller decides
/// what to do with kills (remove actor, spawn death animation, etc.).
///
/// Damage is clamped to [0, target.health] — no overkill, no negative damage.
pub fn apply_damage(target: &mut CompositeActor, base_damage: i32) -> DamageResult {
    let clamped = base_damage.max(0).min(target.health);
    let alive = target.take_damage(clamped);
    DamageResult {
        target_id: target.id,
        damage_dealt: clamped,
        new_health: target.health,
        is_kill: !alive,
    }
}

/// Calculate damage from attacker to defender.
///
/// Currently returns base_damage unmodified. Extension points for scripts:
/// - Weapon modifiers (base_damage comes from weapon definition)
/// - Armor reduction (defender stats not yet in CompositeActor)
/// - Distance falloff (caller computes distance)
/// - Critical hits (RNG from Rhai script)
pub fn calculate_damage(base_damage: i32) -> i32 {
    base_damage
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::CompositeActor;
    use glam::Vec2;

    fn make_actor(id: u32, health: i32) -> CompositeActor {
        let mut a = CompositeActor::new(ActorId(id), Vec2::ZERO, "test".to_string());
        a.health = health;
        a.max_health = health;
        a
    }

    #[test]
    fn damage_reduces_health() {
        let mut target = make_actor(1, 100);
        let result = apply_damage(&mut target, 30);
        assert_eq!(result.damage_dealt, 30);
        assert_eq!(result.new_health, 70);
        assert!(!result.is_kill);
    }

    #[test]
    fn lethal_damage_kills() {
        let mut target = make_actor(1, 50);
        let result = apply_damage(&mut target, 50);
        assert_eq!(result.damage_dealt, 50);
        assert_eq!(result.new_health, 0);
        assert!(result.is_kill);
    }

    #[test]
    fn overkill_clamped() {
        let mut target = make_actor(1, 30);
        let result = apply_damage(&mut target, 999);
        assert_eq!(result.damage_dealt, 30);
        assert_eq!(result.new_health, 0);
        assert!(result.is_kill);
    }

    #[test]
    fn negative_damage_clamped_to_zero() {
        let mut target = make_actor(1, 100);
        let result = apply_damage(&mut target, -10);
        assert_eq!(result.damage_dealt, 0);
        assert_eq!(result.new_health, 100);
        assert!(!result.is_kill);
    }

    #[test]
    fn zero_health_actor_is_killed_by_any_damage() {
        let mut target = make_actor(1, 1);
        let result = apply_damage(&mut target, 1);
        assert!(result.is_kill);
    }

    #[test]
    fn calculate_damage_passthrough() {
        assert_eq!(calculate_damage(25), 25);
        assert_eq!(calculate_damage(0), 0);
    }
}
