//! Effect projection — maps semantic domain events to visual effect intents.
//!
//! This module is the **art-direction seam**. It translates game events
//! (`AttackResolved`, `UnitKilled`, etc.) into visual effect descriptors
//! without coupling to any rendering engine or framework.
//!
//! # Architecture
//!
//! ```text
//! core/GameEvent  →  project_effects()  →  Vec<VisualEffect>
//!                        (this module)
//!                                        →  infrastructure translates
//!                                           to engine API calls
//! ```
//!
//! Core emits semantic domain events. This adapter projects them into
//! visual vocabulary. Infrastructure performs the mechanical translation
//! to engine primitives (`add_arc`, `spawn_particles`, etc.).
//!
//! # Design Decisions
//!
//! - **Core never names visual effects.** `AttackResolved` is domain
//!   vocabulary; `Beam` and `SparkBurst` are adapter vocabulary.
//! - **One projection function, not one per event.** Keeps the mapping
//!   centralized and easy to audit.
//! - **Positions are world-space `(f32, f32)`.** Infrastructure handles
//!   the world-to-screen transformation.
//! - **Intensity is normalized 0..1.** Infrastructure maps to engine-
//!   specific parameter ranges (particle count, arc width, etc.).
//!
//! See `docs/effects-and-visibility-plan.md` for the full architecture.

use zapsquad_core::entities::game_rules::GameEvent;

// ---------------------------------------------------------------------------
// Visual effect types (adapter vocabulary — never used in core)
// ---------------------------------------------------------------------------

/// Visual effect intent — adapter vocabulary for rendering effects.
///
/// These types describe *what* should appear visually, not *how* to render it.
/// Infrastructure translates each variant to specific engine API calls.
#[derive(Debug, Clone, PartialEq)]
pub enum VisualEffect {
    /// Energy beam / laser trace from source to target.
    ///
    /// Infrastructure maps this to `EffectsState::add_arc()` with additive
    /// blending. The engine's arcs have no built-in lifetime — infrastructure
    /// manages expiry via `effects_clear_countdown` (see `BEAM_LIFETIME_FRAMES`
    /// in wasm-canvas).
    Beam {
        /// Origin position in world units.
        from: (f32, f32),
        /// Target position in world units.
        to: (f32, f32),
    },

    /// Burst of sparks at a point of impact.
    ///
    /// Infrastructure maps this to `EffectsState::spawn_particles()` with
    /// additive blending. Particle count scales with intensity.
    SparkBurst {
        /// Impact position in world units.
        position: (f32, f32),
        /// Normalized intensity (0.0 = minimal, 1.0 = maximum).
        /// Infrastructure maps to particle count and speed.
        intensity: f32,
    },
}

// ---------------------------------------------------------------------------
// Projection function
// ---------------------------------------------------------------------------

/// Project domain events into visual effects.
///
/// Pure function. Each domain event maps to zero or more visual effects.
/// Unknown or irrelevant events produce an empty vec (no panic, no log).
///
/// This function is the sole mapping between domain semantics and visual
/// vocabulary. Changing how an attack *looks* means changing this function,
/// not touching core or infrastructure.
pub fn project_effects(event: &GameEvent) -> Vec<VisualEffect> {
    match event {
        GameEvent::AttackResolved {
            attacker_pos,
            target_pos,
            hit,
            damage,
            ..
        } => {
            let mut effects = vec![VisualEffect::Beam {
                from: *attacker_pos,
                to: *target_pos,
            }];

            if *hit {
                // Normalize damage to 0..1 range for intensity.
                // 50 damage = full intensity. Clamped so extreme values
                // don't produce absurd particle counts downstream.
                let intensity = (damage.abs() / 50.0).clamp(0.0, 1.0);
                effects.push(VisualEffect::SparkBurst {
                    position: *target_pos,
                    intensity,
                });
            }

            effects
        }

        // Future: UnitKilled -> DeathFlash + SmokePuff
        // Future: ExplosionOccurred -> SparkBurst + SmokePuff + DustCloud
        // Future: HazardTriggered -> environment-specific effects
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use zapsquad_core::entities::game_rules::CharacterInstanceId;

    fn attack_event(
        attacker_pos: (f32, f32),
        target_pos: (f32, f32),
        damage: f32,
        hit: bool,
    ) -> GameEvent {
        GameEvent::AttackResolved {
            attacker_id: CharacterInstanceId(1),
            target_id: CharacterInstanceId(2),
            damage,
            hit,
            attacker_pos,
            target_pos,
        }
    }

    #[test]
    fn attack_hit_produces_beam_and_sparks() {
        let event = attack_event((1.0, 2.0), (5.0, 6.0), 10.0, true);
        let effects = project_effects(&event);

        assert_eq!(effects.len(), 2);
        assert_eq!(
            effects[0],
            VisualEffect::Beam {
                from: (1.0, 2.0),
                to: (5.0, 6.0),
            }
        );
        match &effects[1] {
            VisualEffect::SparkBurst { position, intensity } => {
                assert_eq!(*position, (5.0, 6.0));
                assert!(*intensity > 0.0);
                assert!(*intensity <= 1.0);
            }
            other => panic!("expected SparkBurst, got {:?}", other),
        }
    }

    #[test]
    fn attack_miss_produces_beam_only() {
        let event = attack_event((0.0, 0.0), (10.0, 10.0), 0.0, false);
        let effects = project_effects(&event);

        assert_eq!(effects.len(), 1);
        assert!(matches!(effects[0], VisualEffect::Beam { .. }));
    }

    #[test]
    fn spark_intensity_scales_with_damage() {
        let low = attack_event((0.0, 0.0), (1.0, 1.0), 5.0, true);
        let high = attack_event((0.0, 0.0), (1.0, 1.0), 50.0, true);

        let low_effects = project_effects(&low);
        let high_effects = project_effects(&high);

        let low_intensity = match &low_effects[1] {
            VisualEffect::SparkBurst { intensity, .. } => *intensity,
            _ => panic!("expected SparkBurst"),
        };
        let high_intensity = match &high_effects[1] {
            VisualEffect::SparkBurst { intensity, .. } => *intensity,
            _ => panic!("expected SparkBurst"),
        };

        assert!(low_intensity < high_intensity);
        assert!((high_intensity - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn spark_intensity_clamped_at_one() {
        let extreme = attack_event((0.0, 0.0), (1.0, 1.0), 999.0, true);
        let effects = project_effects(&extreme);

        match &effects[1] {
            VisualEffect::SparkBurst { intensity, .. } => {
                assert!((intensity - 1.0).abs() < f32::EPSILON);
            }
            _ => panic!("expected SparkBurst"),
        }
    }

    #[test]
    fn unrelated_events_produce_no_effects() {
        assert!(project_effects(&GameEvent::GameStart).is_empty());
        assert!(project_effects(&GameEvent::Tick { dt: 0.016 }).is_empty());
        assert!(project_effects(&GameEvent::UnitKilled {
            character_id: CharacterInstanceId(1),
            killer_id: None,
        })
        .is_empty());
    }

    #[test]
    fn zero_damage_hit_still_produces_sparks() {
        // A hit with 0 damage (e.g., absorbed by armor) should still spark
        let event = attack_event((0.0, 0.0), (3.0, 4.0), 0.0, true);
        let effects = project_effects(&event);

        assert_eq!(effects.len(), 2);
        match &effects[1] {
            VisualEffect::SparkBurst { intensity, .. } => {
                assert!((intensity - 0.0).abs() < f32::EPSILON);
            }
            _ => panic!("expected SparkBurst"),
        }
    }

    #[test]
    fn beam_positions_match_event_positions() {
        let event = attack_event((3.5, 7.2), (12.1, 0.8), 10.0, false);
        let effects = project_effects(&event);

        match &effects[0] {
            VisualEffect::Beam { from, to } => {
                assert_eq!(*from, (3.5, 7.2));
                assert_eq!(*to, (12.1, 0.8));
            }
            _ => panic!("expected Beam"),
        }
    }
}
