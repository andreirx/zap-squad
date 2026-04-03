//! Game event system — pub/sub for rules scripts.
//!
//! The engine emits events. Rules scripts subscribe to them.
//! Events carry context data as flexible key-value pairs.

use super::types::{Stats, TeamId};
use super::character::CharacterInstanceId;

/// Game event types emitted by the engine.
///
/// Rules scripts receive these and decide how to respond.
/// The event data is passed as a Stats (HashMap<String, f32>) for flexibility —
/// scripts can read whatever fields they need.
#[derive(Debug, Clone)]
pub enum GameEvent {
    /// Game session has started. World is ready, teams are initialized.
    GameStart,

    // ── Real-time events (RTS, Tactical exploration phase) ──────────

    /// Real-time frame update. Fired every frame during Exploration or RealTime mode.
    /// Rules scripts use this for resource ticking, wave spawning, etc.
    Tick { dt: f32 },

    // ── Turn-based events ───────────────────────────────────────────

    /// A discrete turn begins. One team gets control. (TurnBased mode.)
    TurnStart { team: TeamId, turn_number: u32 },

    /// A discrete turn ends. Switching to next team.
    TurnEnd { team: TeamId, turn_number: u32 },

    // ── Tactical encounter events (KOTOR/XCOM model) ────────────────

    /// Two opposing teams' units are now in contact (Tactical mode).
    /// Triggers pause and transition to EncounterDecision.
    EncounterTriggered { teams: (TeamId, TeamId) },

    /// Planning phase begins. Players/AI choose actions. (Tactical mode.)
    PlanningStart,

    /// Planning phase ends. All decisions locked in.
    PlanningEnd,

    /// Resolution phase begins. Actions play out.
    ResolutionStart,

    /// Resolution phase ends. Check if encounter continues.
    ResolutionEnd,

    /// Encounter fully resolved. All enemies dead or fled. Return to Exploration.
    EncounterResolved,

    // ── Combat events ────────────────────────────────────────────────

    /// An attack was resolved between two characters.
    ///
    /// Emitted by infrastructure after `apply_damage`. Carries world-space
    /// positions at the time of the attack so downstream consumers (rules
    /// scripts, effect projection) have spatial context without needing to
    /// look up actor state after the fact.
    AttackResolved {
        attacker_id: CharacterInstanceId,
        target_id: CharacterInstanceId,
        damage: f32,
        hit: bool,
        /// Attacker world position at time of attack (world units, not pixels).
        attacker_pos: (f32, f32),
        /// Target world position at time of attack (world units, not pixels).
        target_pos: (f32, f32),
    },

    // ── Unit lifecycle events ────────────────────────────────────────

    /// A character was spawned.
    UnitSpawned { character_id: CharacterInstanceId, team: TeamId },

    /// A character took damage.
    UnitDamaged {
        character_id: CharacterInstanceId,
        attacker_id: Option<CharacterInstanceId>,
        damage: f32,
        remaining_hp: f32,
    },

    /// A character was killed.
    UnitKilled {
        character_id: CharacterInstanceId,
        killer_id: Option<CharacterInstanceId>,
    },

    /// A character's stat changed (XP gained, morale dropped, etc.).
    StatChanged {
        character_id: CharacterInstanceId,
        stat_key: String,
        old_value: f32,
        new_value: f32,
    },

    /// A resource changed for a team.
    ResourceChanged {
        team: TeamId,
        resource_key: String,
        old_value: f32,
        new_value: f32,
    },

    /// A wave of enemies is spawning (tower defense style).
    WaveStart { wave_number: u32 },

    /// A wave has been fully defeated.
    WaveComplete { wave_number: u32 },

    /// A unit entered a trigger zone on the map.
    ZoneEntered {
        character_id: CharacterInstanceId,
        zone_id: String,
    },

    /// A unit left a trigger zone.
    ZoneExited {
        character_id: CharacterInstanceId,
        zone_id: String,
    },

    /// Custom event emitted by scripts. Allows game-specific events
    /// that the engine doesn't need to understand.
    Custom {
        name: String,
        data: Stats,
    },
}

/// A queue of pending game events waiting to be processed by scripts.
#[derive(Debug, Clone, Default)]
pub struct EventQueue {
    events: Vec<GameEvent>,
}

impl EventQueue {
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    pub fn push(&mut self, event: GameEvent) {
        self.events.push(event);
    }

    pub fn drain(&mut self) -> Vec<GameEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_queue_drain() {
        let mut q = EventQueue::new();
        q.push(GameEvent::GameStart);
        q.push(GameEvent::TurnStart { team: TeamId(0), turn_number: 1 });

        assert_eq!(q.len(), 2);
        let drained = q.drain();
        assert_eq!(drained.len(), 2);
        assert!(q.is_empty());
    }
}
