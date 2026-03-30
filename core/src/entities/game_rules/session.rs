//! Game session — runtime state during a playable game.

use std::collections::HashMap;
use super::types::{GameMode, GamePhase, TeamId};
use super::team::{TeamState, TeamRelation};
use super::character::{CharacterInstance, CharacterInstanceId};
use super::event::EventQueue;
use super::definition::GameDefinition;

/// The complete runtime state of a game session.
///
/// Created from a GameDefinition when the player starts a game.
/// Owned by the WASM game loop. Modified by rules scripts via
/// the adapters layer.
#[derive(Debug)]
pub struct GameSession {
    /// What kind of time model this game uses.
    pub mode: GameMode,
    /// Current phase of the game.
    pub phase: GamePhase,
    /// Game clock. In RealTime, advances by dt. In TurnBased, advances by action.
    pub clock: f32,
    /// Current turn number (TurnBased/Tactical modes).
    pub turn_number: u32,
    /// Which team is currently active (TurnBased mode).
    pub active_team: Option<TeamId>,

    /// Per-team runtime state. Ordered for deterministic turn rotation.
    pub teams: Vec<TeamState>,
    /// Relations between teams.
    pub relations: HashMap<(TeamId, TeamId), TeamRelation>,

    /// All character instances in the game (alive and dead).
    /// Keyed by domain-level CharacterInstanceId (stable, not renderer ActorId).
    pub characters: HashMap<CharacterInstanceId, CharacterInstance>,
    /// Next character instance ID for spawning.
    next_character_id: u32,

    /// Named zones defined by world gen or level design.
    /// Used for spawn points, encounter areas, objectives, etc.
    pub zones: Vec<Zone>,

    /// Pending events for script consumption.
    pub events: EventQueue,
}

/// A named spatial zone on the game map.
#[derive(Debug, Clone)]
pub struct Zone {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub zone_type: String,
    pub team_id: Option<TeamId>,
}

impl GameSession {
    /// Create a new session in Setup phase.
    pub fn new(mode: GameMode) -> Self {
        Self {
            mode,
            phase: GamePhase::Setup,
            clock: 0.0,
            turn_number: 0,
            active_team: None,
            teams: Vec::new(),
            relations: HashMap::new(),
            characters: HashMap::new(),
            next_character_id: 1,
            zones: Vec::new(),
            events: EventQueue::new(),
        }
    }

    /// Create a session from a game definition. Initializes teams with
    /// starting resources from the resource schema and sets all relations to Hostile.
    pub fn from_definition(def: &GameDefinition) -> Self {
        let mut session = Self::new(def.mode);
        let starting_resources = def.resource_schema.starting_resources();

        for team_def in &def.teams {
            let mut state = TeamState::from_definition(team_def);
            state.resources = starting_resources.clone();
            session.teams.push(state);
        }

        // Default: all teams hostile to each other
        for i in 0..def.teams.len() {
            for j in (i + 1)..def.teams.len() {
                session.set_relation(def.teams[i].id, def.teams[j].id, TeamRelation::Hostile);
            }
        }

        session
    }

    /// Add a team to the session. Order of addition determines turn order.
    pub fn add_team(&mut self, state: TeamState) {
        self.teams.push(state);
    }

    /// Get a team by ID.
    pub fn team(&self, id: TeamId) -> Option<&TeamState> {
        self.teams.iter().find(|t| t.id == id)
    }

    /// Get a mutable team by ID.
    pub fn team_mut(&mut self, id: TeamId) -> Option<&mut TeamState> {
        self.teams.iter_mut().find(|t| t.id == id)
    }

    /// Set relation between two teams (symmetric).
    pub fn set_relation(&mut self, a: TeamId, b: TeamId, relation: TeamRelation) {
        self.relations.insert((a, b), relation);
        self.relations.insert((b, a), relation);
    }

    /// Get the relation between two teams. Defaults to Hostile.
    pub fn relation(&self, a: TeamId, b: TeamId) -> TeamRelation {
        if a == b {
            return TeamRelation::Allied;
        }
        self.relations.get(&(a, b)).copied().unwrap_or(TeamRelation::Hostile)
    }

    /// Allocate a new CharacterInstanceId.
    pub fn next_character_id(&mut self) -> CharacterInstanceId {
        let id = CharacterInstanceId(self.next_character_id);
        self.next_character_id += 1;
        id
    }

    /// Add a character instance to the session.
    pub fn add_character(&mut self, instance: CharacterInstance) {
        self.characters.insert(instance.id, instance);
    }

    /// Get a character by instance ID.
    pub fn character(&self, id: CharacterInstanceId) -> Option<&CharacterInstance> {
        self.characters.get(&id)
    }

    /// Get a mutable character by instance ID.
    pub fn character_mut(&mut self, id: CharacterInstanceId) -> Option<&mut CharacterInstance> {
        self.characters.get_mut(&id)
    }

    /// Get all living characters for a team.
    pub fn team_characters(&self, team: TeamId) -> Vec<&CharacterInstance> {
        self.characters.values()
            .filter(|c| c.team_id == team && c.alive)
            .collect()
    }

    /// Check if a team has been eliminated (no living characters).
    pub fn is_team_eliminated(&self, team: TeamId) -> bool {
        !self.characters.values().any(|c| c.team_id == team && c.alive)
    }

    /// Define a named spatial zone (spawn point, encounter area, etc.).
    pub fn define_zone(
        &mut self,
        name: String,
        x: i32, y: i32,
        width: i32, height: i32,
        zone_type: String,
        team_id: Option<TeamId>,
    ) {
        self.zones.push(Zone { name, x, y, width, height, zone_type, team_id });
    }

    /// Get alive character count per team.
    pub fn alive_counts(&self) -> HashMap<TeamId, usize> {
        let mut counts = HashMap::new();
        for c in self.characters.values() {
            if c.alive {
                *counts.entry(c.team_id).or_insert(0) += 1;
            }
        }
        counts
    }

    /// Transition to a new phase.
    pub fn transition(&mut self, phase: GamePhase) {
        self.phase = phase;
    }

    /// Advance the clock by dt (RealTime/Tactical modes).
    pub fn tick(&mut self, dt: f32) {
        self.clock += dt;
    }

    /// Advance to the next turn (TurnBased mode).
    /// Turn order is deterministic — follows the order teams were added.
    pub fn next_turn(&mut self) {
        self.turn_number += 1;
        if self.teams.is_empty() { return; }
        if let Some(current) = self.active_team {
            let idx = self.teams.iter().position(|t| t.id == current).unwrap_or(0);
            let next_idx = (idx + 1) % self.teams.len();
            self.active_team = Some(self.teams[next_idx].id);
        } else {
            self.active_team = Some(self.teams[0].id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::team::{TeamDefinition, TeamController};

    fn make_session() -> GameSession {
        let mut session = GameSession::new(GameMode::Tactical);

        let team_a = TeamDefinition {
            id: TeamId(0),
            name: "Humans".into(),
            controller: TeamController::Human,
            color: "#4ecca3".into(),
        };
        let team_b = TeamDefinition {
            id: TeamId(1),
            name: "Aliens".into(),
            controller: TeamController::Cpu { script_name: "alien_ai".into() },
            color: "#e94560".into(),
        };

        session.add_team(TeamState::from_definition(&team_a));
        session.add_team(TeamState::from_definition(&team_b));
        session.set_relation(TeamId(0), TeamId(1), TeamRelation::Hostile);
        session
    }

    #[test]
    fn team_relations() {
        let session = make_session();
        assert_eq!(session.relation(TeamId(0), TeamId(0)), TeamRelation::Allied);
        assert_eq!(session.relation(TeamId(0), TeamId(1)), TeamRelation::Hostile);
        assert_eq!(session.relation(TeamId(1), TeamId(0)), TeamRelation::Hostile);
    }

    #[test]
    fn character_management() {
        let mut session = make_session();

        let mut stats = super::super::types::Stats::new();
        stats.insert("hp".into(), 100.0);

        let cid = session.next_character_id();
        let inst = CharacterInstance::standalone(cid, TeamId(0), stats);
        session.add_character(inst);

        assert_eq!(session.team_characters(TeamId(0)).len(), 1);
        assert_eq!(session.team_characters(TeamId(1)).len(), 0);
        assert!(!session.is_team_eliminated(TeamId(0)));
        assert!(session.is_team_eliminated(TeamId(1)));
    }

    #[test]
    fn turn_rotation() {
        let mut session = make_session();
        session.active_team = Some(TeamId(0));

        session.next_turn();
        assert_eq!(session.turn_number, 1);
        // Deterministic: teams are Vec-ordered, so TeamId(0) → TeamId(1)
        assert_eq!(session.active_team, Some(TeamId(1)));

        session.next_turn();
        assert_eq!(session.turn_number, 2);
        // Wraps back to first team
        assert_eq!(session.active_team, Some(TeamId(0)));
    }

    #[test]
    fn session_from_definition() {
        use super::super::definition::*;
        use super::super::types::*;
        use super::super::resource::*;

        let mut def = GameDefinition::new("Test", GameMode::Tactical);
        def.teams.push(TeamDefinition {
            id: TeamId(0), name: "A".into(),
            controller: TeamController::Human, color: "#fff".into(),
        });
        def.teams.push(TeamDefinition {
            id: TeamId(1), name: "B".into(),
            controller: TeamController::Cpu { script_name: "ai".into() },
            color: "#000".into(),
        });
        def.resource_schema = ResourceSchema::new()
            .add(ResourceDef::new("gold", "Gold").with_start(500.0))
            .add(ResourceDef::new("supply", "Supply").with_start(10.0));

        let session = GameSession::from_definition(&def);
        assert_eq!(session.teams.len(), 2);
        // Starting resources applied from schema
        assert_eq!(session.teams[0].resources["gold"], 500.0);
        assert_eq!(session.teams[0].resources["supply"], 10.0);
        assert_eq!(session.teams[1].resources["gold"], 500.0);
        // Teams are hostile by default
        assert_eq!(session.relation(TeamId(0), TeamId(1)), TeamRelation::Hostile);
    }
}
