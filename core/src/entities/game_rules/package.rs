//! Rules package — the activation contract around a game definition.
//!
//! A `RulesPackage` wraps a `GameDefinition` (stable game mechanics) with the
//! structural metadata needed to gate activation:
//!
//! - **Prerequisites**: declarative descriptors of what must exist in the world
//! - **Verifier binding**: name of a Rhai script that authoritatively gates activation
//! - **Verification result**: structured pass/fail output from prerequisite checks
//!
//! Presentation-layer metadata (HUD titles, display toggles, ready text) does NOT
//! belong in core. It lives in the UI layer, keyed to the package's stable `id`.
//!
//! The declarative prerequisites are UI hints — they let the product show checkmarks
//! and progress before the verifier runs. The verifier script is the authoritative
//! gate. If they disagree, the verifier wins.
//!
//! # Execution phases
//!
//! Three distinct phases use different contexts:
//! - **Sandbox AI preview**: canvas/world DTOs, no session required
//! - **Verifier**: authored world snapshot, read-only, structured result
//! - **Runtime rules**: active session state, mutating, event-driven (GAME ON only)

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use super::definition::GameDefinition;

// ── Rules Package ────────────────────────────────────────────────────────────

/// A rules package — activation contract around a game definition.
///
/// Wraps a `GameDefinition` (stable game mechanics) with the structural
/// prerequisites and verifier binding needed to gate GAME ON activation.
///
/// Presentation metadata (HUD config, titles, display preferences) is
/// intentionally excluded from core — it belongs in the UI layer.
///
/// Stored alongside worlds in IDB. Authored in the Rules Editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulesPackage {
    /// Stable identifier. Used as the cross-layer key for UI metadata,
    /// persistence, and package references. Immutable after construction.
    /// Access via `id()`. Serde can deserialize into this field but code
    /// outside this module cannot mutate it.
    id: String,
    /// Human-readable name (e.g., "Playground Soccer", "Arena Deathmatch").
    pub name: String,
    /// Description of what this game is about.
    pub description: String,
    /// The game definition containing teams, templates, stats, resources,
    /// rules script, world gen script, and win conditions.
    pub definition: GameDefinition,
    /// Declarative prerequisites for UI display.
    /// These are hints — the verifier script (if any) is authoritative.
    pub prerequisites: Vec<Prerequisite>,
    /// Name of the Rhai verifier script. Entry point: `fn verify(ctx)`.
    /// The verifier inspects the authored world state (read-only) and returns
    /// a structured pass/fail result. If None, only declarative prerequisites
    /// are checked mechanically.
    pub verifier_script: Option<String>,
}

impl RulesPackage {
    /// Create a minimal rules package wrapping a game definition.
    /// Stable identifier. Immutable after construction.
    pub fn id(&self) -> &str { &self.id }

    pub fn new(id: impl Into<String>, name: impl Into<String>, definition: GameDefinition) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            definition,
            prerequisites: Vec::new(),
            verifier_script: None,
        }
    }

    /// Add a declarative prerequisite.
    pub fn with_prerequisite(mut self, prereq: Prerequisite) -> Self {
        self.prerequisites.push(prereq);
        self
    }

    /// Set the verifier script name.
    pub fn with_verifier(mut self, script_name: impl Into<String>) -> Self {
        self.verifier_script = Some(script_name.into());
        self
    }

    /// Mechanically check declarative prerequisites against a world snapshot.
    /// Returns one result per prerequisite. Does NOT run the verifier script.
    /// The verifier script is the authoritative gate — these are UI hints only.
    ///
    /// Team-scoped prerequisites (like `MinCharactersPerTeam`) are evaluated
    /// against the package's declared teams, not every team ID on the board.
    pub fn check_prerequisites(&self, world: &WorldSnapshot) -> Vec<PrerequisiteCheckResult> {
        let ctx = self.check_context(world);
        self.prerequisites.iter().map(|p| p.check(&ctx)).collect()
    }

    /// Check if all mechanically-checkable prerequisites pass.
    /// `Custom` prerequisites are skipped — they are verifier-only by design
    /// and cannot be resolved without running the verifier script.
    /// Does NOT run the verifier script.
    pub fn all_mechanical_prerequisites_met(&self, world: &WorldSnapshot) -> bool {
        let ctx = self.check_context(world);
        self.prerequisites.iter().all(|p| {
            if matches!(p, Prerequisite::Custom { .. }) {
                true // verifier-only — mechanical check cannot evaluate
            } else {
                p.check(&ctx).satisfied
            }
        })
    }

    /// Build the check context from this package's definition and the world.
    fn check_context<'a>(&self, world: &'a WorldSnapshot) -> CheckContext<'a> {
        let participating_teams: Vec<u32> = self.definition.teams.iter()
            .map(|t| t.id.0)
            .collect();
        CheckContext { world, participating_teams }
    }

    /// Whether this package has custom prerequisites that require a verifier.
    pub fn has_custom_prerequisites(&self) -> bool {
        self.prerequisites.iter().any(|p| matches!(p, Prerequisite::Custom { .. }))
    }

    /// Whether this package requires a verifier to fully validate.
    /// True if there's a verifier script OR any custom prerequisites.
    pub fn requires_verifier(&self) -> bool {
        self.verifier_script.is_some() || self.has_custom_prerequisites()
    }
}

/// Context for mechanical prerequisite checking.
/// Carries the world snapshot plus definition-derived metadata (participating teams).
pub struct CheckContext<'a> {
    pub world: &'a WorldSnapshot,
    /// Team IDs from the package's `GameDefinition.teams`.
    /// Team-scoped prerequisites check only these teams, not strays on the board.
    pub participating_teams: Vec<u32>,
}

// ── Prerequisites ────────────────────────────────────────────────────────────

/// A declarative prerequisite — something that must exist in the world.
///
/// These are UI-facing hints that let the product show checkmarks and progress.
/// The verifier script is authoritative if it exists. Declarative prerequisites
/// are mechanically checked against a `WorldSnapshot`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Prerequisite {
    /// At least N teams must have characters placed on the board.
    MinTeams {
        count: u32,
        /// UI label (e.g., "At least 2 teams with players").
        description: String,
    },
    /// At least N characters total on the board (all teams, including strays).
    MinCharactersTotal {
        count: u32,
        description: String,
    },
    /// At least N characters across the package's participating teams only.
    /// Stray/neutral team characters are not counted.
    MinCharactersOnTeams {
        count: u32,
        description: String,
    },
    /// At least N characters per team.
    MinCharactersPerTeam {
        count: u32,
        description: String,
    },
    /// A zone of a specific type must exist.
    ZoneExists {
        zone_type: String,
        min_count: u32,
        description: String,
    },
    /// A specific tile type must cover at least N cells.
    TileExists {
        asset_name: String,
        min_count: u32,
        description: String,
    },
    /// Custom prerequisite — checked only by the verifier script.
    /// Mechanical check returns `satisfied: false` because only the
    /// verifier can evaluate arbitrary domain logic. The `Custom`
    /// variant is skipped by `all_mechanical_prerequisites_met()`.
    Custom {
        /// Key for the verifier to reference.
        key: String,
        description: String,
    },
}

impl Prerequisite {
    /// Mechanically check this prerequisite against a check context.
    ///
    /// The `CheckContext` carries the world snapshot plus definition-derived
    /// metadata (participating teams). Team-scoped prerequisites check only
    /// the package's declared teams, not strays on the board.
    pub fn check(&self, ctx: &CheckContext) -> PrerequisiteCheckResult {
        let world = ctx.world;
        match self {
            Prerequisite::MinTeams { count, description } => {
                // Count participating teams that have at least one character
                let per_team = world.characters_per_team();
                let actual = ctx.participating_teams.iter()
                    .filter(|t| per_team.get(t).copied().unwrap_or(0) > 0)
                    .count() as u32;
                PrerequisiteCheckResult {
                    satisfied: actual >= *count,
                    description: description.clone(),
                    detail: Some(format!("{}/{} teams", actual, count)),
                    verifier_only: false,
                }
            }
            Prerequisite::MinCharactersTotal { count, description } => {
                let actual = world.characters.len() as u32;
                PrerequisiteCheckResult {
                    satisfied: actual >= *count,
                    description: description.clone(),
                    detail: Some(format!("{}/{} characters (all teams)", actual, count)),
                    verifier_only: false,
                }
            }
            Prerequisite::MinCharactersOnTeams { count, description } => {
                let per_team = world.characters_per_team();
                let actual: u32 = ctx.participating_teams.iter()
                    .map(|t| per_team.get(t).copied().unwrap_or(0))
                    .sum();
                PrerequisiteCheckResult {
                    satisfied: actual >= *count,
                    description: description.clone(),
                    detail: Some(format!("{}/{} characters (participating teams)", actual, count)),
                    verifier_only: false,
                }
            }
            Prerequisite::MinCharactersPerTeam { count, description } => {
                // Check only participating teams — neutral/stray teams are ignored
                let per_team = world.characters_per_team();
                let satisfied = if ctx.participating_teams.is_empty() {
                    false
                } else {
                    ctx.participating_teams.iter().all(|t| {
                        per_team.get(t).copied().unwrap_or(0) >= *count
                    })
                };
                PrerequisiteCheckResult {
                    satisfied,
                    description: description.clone(),
                    verifier_only: false,
                    detail: Some(
                        ctx.participating_teams.iter()
                            .map(|t| format!("team {}: {}", t, per_team.get(t).copied().unwrap_or(0)))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                }
            }
            Prerequisite::ZoneExists { zone_type, min_count, description } => {
                let actual = world.zones.iter()
                    .filter(|z| z.zone_type == *zone_type)
                    .count() as u32;
                PrerequisiteCheckResult {
                    satisfied: actual >= *min_count,
                    description: description.clone(),
                    detail: Some(format!("{}/{} '{}' zones", actual, min_count, zone_type)),
                    verifier_only: false,
                }
            }
            Prerequisite::TileExists { asset_name, min_count, description } => {
                let tile_counts = world.tile_counts();
                let actual = tile_counts.get(asset_name).copied().unwrap_or(0);
                PrerequisiteCheckResult {
                    satisfied: actual >= *min_count,
                    description: description.clone(),
                    detail: Some(format!("{}/{} '{}' tiles", actual, min_count, asset_name)),
                    verifier_only: false,
                }
            }
            Prerequisite::Custom { key: _, description } => {
                // Custom prerequisites cannot be mechanically checked.
                // Always unsatisfied — only the verifier script can clear them.
                PrerequisiteCheckResult {
                    satisfied: false,
                    description: description.clone(),
                    detail: Some("requires verifier".into()),
                    verifier_only: true,
                }
            }
        }
    }
}

/// Result of checking a single declarative prerequisite.
#[derive(Debug, Clone)]
pub struct PrerequisiteCheckResult {
    /// Whether the prerequisite is currently met.
    pub satisfied: bool,
    /// Human-readable description of the prerequisite.
    pub description: String,
    /// Optional detail (e.g., "2/3 teams", "5/10 grass tiles").
    pub detail: Option<String>,
    /// Whether this result is from a Custom (verifier-only) prerequisite.
    /// Custom results are always mechanically unsatisfied but should not
    /// block activation in a mechanical-only verification pass.
    pub verifier_only: bool,
}

// ── Verification Result ──────────────────────────────────────────────────────

/// Structured output from the verification phase.
///
/// Produced by either:
/// - Mechanical prerequisite checking (`RulesPackage::check_prerequisites`)
/// - The verifier Rhai script (authoritative, runs through adapters layer)
///
/// If both run, the verifier result is authoritative.
#[derive(Debug, Clone)]
pub struct VerificationResult {
    /// Whether the world satisfies all requirements for activation.
    pub passed: bool,
    /// Individual check results (from declarative prerequisites).
    pub prerequisite_results: Vec<PrerequisiteCheckResult>,
    /// Failures reported by the verifier script (if any ran).
    /// These take precedence over prerequisite results.
    pub verifier_failures: Vec<VerificationFailure>,
}

impl VerificationResult {
    /// Create a passing result with no failures.
    pub fn pass(prerequisite_results: Vec<PrerequisiteCheckResult>) -> Self {
        Self {
            passed: true,
            prerequisite_results,
            verifier_failures: Vec::new(),
        }
    }

    /// Create a result from prerequisite checks alone (no verifier).
    ///
    /// Verifier-only results (from `Custom` prerequisites) are excluded from
    /// the pass/fail decision — they cannot be resolved without the verifier.
    /// The `verifier_only` flag on each result drives this.
    pub fn from_prerequisites(results: Vec<PrerequisiteCheckResult>) -> Self {
        let passed = results.iter().all(|r| r.satisfied || r.verifier_only);
        Self {
            passed,
            prerequisite_results: results,
            verifier_failures: Vec::new(),
        }
    }

    /// Create a result from verifier script output.
    /// The verifier is authoritative — its failures override prerequisite results.
    pub fn from_verifier(
        prerequisite_results: Vec<PrerequisiteCheckResult>,
        verifier_failures: Vec<VerificationFailure>,
    ) -> Self {
        let passed = verifier_failures.iter()
            .all(|f| f.severity != FailureSeverity::Error);
        Self {
            passed,
            prerequisite_results,
            verifier_failures,
        }
    }
}

/// A failure reported by the verifier script.
#[derive(Debug, Clone)]
pub struct VerificationFailure {
    /// Which prerequisite key this failure relates to (if any).
    pub prerequisite_key: Option<String>,
    /// Human-readable explanation of what's wrong.
    pub message: String,
    /// Whether this blocks activation or is just a warning.
    pub severity: FailureSeverity,
}

/// Severity of a verification failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureSeverity {
    /// Blocks activation. The game cannot start.
    Error,
    /// Notable but does not block activation.
    Warning,
}

// ── World Snapshot ───────────────────────────────────────────────────────────

/// Read-only snapshot of the authored world state for verification.
///
/// This is the boundary DTO between the board (infrastructure) and the
/// verification phase (core + adapters). Built by the WASM layer from
/// the current board state. Passed to both:
/// - `RulesPackage::check_prerequisites()` (core, mechanical)
/// - The verifier Rhai script (adapters, authoritative)
///
/// Contains only authored state — not live match state.
///
/// The snapshot carries canonical data (`characters`, `objects`, `zones`, `tiles`).
/// Aggregates like team counts and per-team character counts are derived by
/// methods, not stored redundantly.
#[derive(Debug, Clone, Default)]
pub struct WorldSnapshot {
    /// Characters on the board with positions and metadata.
    pub characters: Vec<SnapshotCharacter>,
    /// Objects on the board (non-character entities: ball, crate, flag, etc.).
    pub objects: Vec<SnapshotObject>,
    /// Named zones defined on the board.
    pub zones: Vec<SnapshotZone>,
    /// Individual tile placements with coordinates.
    /// Enables spatial queries ("is there grass at (5,5)?", "are all goal
    /// zone tiles water?"). Built by iterating the sparse world.
    pub tiles: Vec<SnapshotTile>,
}

impl WorldSnapshot {
    /// Derive the set of team IDs that have at least one character.
    pub fn teams_with_characters(&self) -> Vec<u32> {
        let mut teams: Vec<u32> = self.characters.iter()
            .map(|c| c.team_id)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        teams.sort();
        teams
    }

    /// Derive character count per team.
    pub fn characters_per_team(&self) -> HashMap<u32, u32> {
        let mut counts = HashMap::new();
        for c in &self.characters {
            *counts.entry(c.team_id).or_insert(0) += 1;
        }
        counts
    }

    /// Derive tile type counts from the canonical tile list.
    pub fn tile_counts(&self) -> HashMap<String, u32> {
        let mut counts = HashMap::new();
        for t in &self.tiles {
            *counts.entry(t.asset_name.clone()).or_insert(0) += 1;
        }
        counts
    }
}

/// A character in the world snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotCharacter {
    pub body_def_id: String,
    pub team_id: u32,
    pub x: f32,
    pub y: f32,
    pub script_name: Option<String>,
}

/// A zone in the world snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotZone {
    pub name: String,
    pub zone_type: String,
    pub team_id: Option<u32>,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// An object in the world snapshot (non-character entity).
/// Examples: ball, crate, flag, loot chest, gate, cover barrier.
#[derive(Debug, Clone)]
pub struct SnapshotObject {
    /// Object type identifier (e.g., "ball", "crate", "flag").
    pub object_type: String,
    pub x: f32,
    pub y: f32,
    /// Optional team ownership (e.g., a team flag).
    pub team_id: Option<u32>,
    /// Typed properties for verifier inspection.
    pub properties: HashMap<String, PropertyValue>,
}

/// A typed property value on a snapshot object.
/// Avoids string parsing in verifier scripts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PropertyValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

/// A single tile placement in the world snapshot.
/// Enables spatial prerequisite queries.
#[derive(Debug, Clone)]
pub struct SnapshotTile {
    pub x: i32,
    pub y: i32,
    pub asset_name: String,
    pub layer: u8,
    pub variant: u8,
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::GameMode;

    fn soccer_package() -> RulesPackage {
        use super::super::team::{TeamDefinition, TeamController};
        use super::super::types::TeamId;
        let mut def = GameDefinition::new("Soccer", GameMode::RealTime);
        def.teams = vec![
            TeamDefinition { id: TeamId(0), name: "Red".into(), controller: TeamController::Human, color: "#ff0000".into() },
            TeamDefinition { id: TeamId(1), name: "Blue".into(), controller: TeamController::Human, color: "#0000ff".into() },
        ];
        RulesPackage::new("soccer", "Playground Soccer", def)
            .with_prerequisite(Prerequisite::MinTeams {
                count: 2,
                description: "Two teams with players".into(),
            })
            .with_prerequisite(Prerequisite::MinCharactersPerTeam {
                count: 3,
                description: "At least 3 players per team".into(),
            })
            .with_prerequisite(Prerequisite::ZoneExists {
                zone_type: "goal".into(),
                min_count: 2,
                description: "Two goal zones".into(),
            })
            .with_prerequisite(Prerequisite::Custom {
                key: "ball_present".into(),
                description: "A ball object must be placed on the field".into(),
            })
            .with_verifier("soccer_verifier")
    }

    fn make_characters(teams: &[(u32, u32)]) -> Vec<SnapshotCharacter> {
        let mut chars = Vec::new();
        for &(team_id, count) in teams {
            for i in 0..count {
                chars.push(SnapshotCharacter {
                    body_def_id: "player".into(),
                    team_id,
                    x: i as f32, y: 0.0,
                    script_name: None,
                });
            }
        }
        chars
    }

    fn make_world(teams: &[(u32, u32)], zones: &[(&str, &str)]) -> WorldSnapshot {
        WorldSnapshot {
            characters: make_characters(teams),
            objects: vec![],
            tiles: vec![],
            zones: zones.iter().map(|(name, zt)| SnapshotZone {
                name: name.to_string(),
                zone_type: zt.to_string(),
                team_id: None,
                x: 0, y: 0, width: 10, height: 10,
            }).collect(),
        }
    }

    #[test]
    fn prerequisites_all_met_except_custom() {
        let pkg = soccer_package();
        let world = make_world(&[(0, 5), (1, 4)], &[("goal_a", "goal"), ("goal_b", "goal")]);
        let results = pkg.check_prerequisites(&world);

        assert!(results[0].satisfied);   // MinTeams: 2/2
        assert!(results[1].satisfied);   // MinCharactersPerTeam: both ≥ 3
        assert!(results[2].satisfied);   // ZoneExists: 2/2 goals
        assert!(!results[3].satisfied);  // Custom: always unsatisfied mechanically

        // all_mechanical_prerequisites_met skips Custom → returns true
        assert!(pkg.all_mechanical_prerequisites_met(&world));
    }

    #[test]
    fn custom_does_not_block_mechanical_check() {
        // A package with ONLY custom prerequisites should pass mechanical check
        let def = GameDefinition::new("Custom Only", GameMode::RealTime);
        let pkg = RulesPackage::new("custom_only", "Custom Only", def)
            .with_prerequisite(Prerequisite::Custom {
                key: "something".into(),
                description: "Needs verifier".into(),
            });
        let world = WorldSnapshot::default();
        assert!(pkg.all_mechanical_prerequisites_met(&world));
        assert!(pkg.requires_verifier());
    }

    #[test]
    fn prerequisites_partially_met() {
        let pkg = soccer_package();
        let world = make_world(&[(0, 5), (1, 1)], &[("goal_a", "goal")]);
        let results = pkg.check_prerequisites(&world);

        assert!(results[0].satisfied);   // 2 teams ✓
        assert!(!results[1].satisfied);  // team 1 has only 1 < 3 ✗
        assert!(!results[2].satisfied);  // 1/2 goals ✗
        assert!(!results[3].satisfied);  // custom ✗

        // Mechanical check fails because MinCharactersPerTeam fails
        assert!(!pkg.all_mechanical_prerequisites_met(&world));
    }

    #[test]
    fn stray_teams_ignored_by_per_team_check() {
        // Soccer package declares teams 0 and 1.
        // Board has teams 0, 1, and a stray team 99 with only 1 character.
        // MinCharactersPerTeam should check only declared teams 0 and 1.
        let pkg = soccer_package();
        let world = make_world(
            &[(0, 5), (1, 4), (99, 1)],
            &[("goal_a", "goal"), ("goal_b", "goal")],
        );
        let results = pkg.check_prerequisites(&world);

        // MinTeams: 2 of declared teams (0, 1) have characters → satisfied
        assert!(results[0].satisfied);
        // MinCharactersPerTeam: team 0=5, team 1=4, both ≥ 3 → satisfied
        // (team 99 is ignored — not a declared team)
        assert!(results[1].satisfied);

        assert!(pkg.all_mechanical_prerequisites_met(&world));
    }

    #[test]
    fn prerequisites_empty_world() {
        let pkg = soccer_package();
        let world = WorldSnapshot::default();
        let results = pkg.check_prerequisites(&world);
        // All fail except Custom is already always-fail
        assert!(results.iter().all(|r| !r.satisfied));
        assert!(!pkg.all_mechanical_prerequisites_met(&world));
    }

    #[test]
    fn world_snapshot_derived_aggregates() {
        let world = make_world(&[(0, 3), (1, 5), (2, 0)], &[]);
        // teams_with_characters excludes team 2 (0 characters)
        let teams = world.teams_with_characters();
        assert_eq!(teams, vec![0, 1]);
        // characters_per_team
        let per_team = world.characters_per_team();
        assert_eq!(per_team.get(&0), Some(&3));
        assert_eq!(per_team.get(&1), Some(&5));
        assert_eq!(per_team.get(&2), None); // no entry for 0 characters
        // total
        assert_eq!(world.characters.len(), 8);
    }

    #[test]
    fn verification_result_from_prerequisites() {
        let results = vec![
            PrerequisiteCheckResult { satisfied: true, description: "A".into(), detail: None, verifier_only: false },
            PrerequisiteCheckResult { satisfied: false, description: "B".into(), detail: None, verifier_only: false },
        ];
        let vr = VerificationResult::from_prerequisites(results);
        assert!(!vr.passed); // B is unsatisfied and not verifier-only
    }

    #[test]
    fn verification_result_skips_verifier_only() {
        let results = vec![
            PrerequisiteCheckResult { satisfied: true, description: "A".into(), detail: None, verifier_only: false },
            PrerequisiteCheckResult { satisfied: false, description: "Custom".into(), detail: None, verifier_only: true },
        ];
        let vr = VerificationResult::from_prerequisites(results);
        assert!(vr.passed); // Custom unsatisfied but verifier_only → skipped
    }

    #[test]
    fn verification_result_verifier_overrides() {
        let prereqs = vec![
            PrerequisiteCheckResult { satisfied: true, description: "A".into(), detail: None, verifier_only: false },
        ];
        let failures = vec![
            VerificationFailure {
                prerequisite_key: None,
                message: "Ball is outside the field".into(),
                severity: FailureSeverity::Error,
            },
        ];
        let vr = VerificationResult::from_verifier(prereqs, failures);
        assert!(!vr.passed);
    }

    #[test]
    fn verification_result_warnings_dont_block() {
        let failures = vec![
            VerificationFailure {
                prerequisite_key: None,
                message: "Uneven team sizes".into(),
                severity: FailureSeverity::Warning,
            },
        ];
        let vr = VerificationResult::from_verifier(vec![], failures);
        assert!(vr.passed);
    }

    #[test]
    fn tile_prerequisite() {
        let def = GameDefinition::new("Grass Game", GameMode::RealTime);
        let pkg = RulesPackage::new("grass_game", "Grass Game", def)
            .with_prerequisite(Prerequisite::TileExists {
                asset_name: "grass".into(),
                min_count: 25,
                description: "At least 25 grass tiles".into(),
            });

        // 10 grass tiles — not enough
        let mut world = WorldSnapshot::default();
        for i in 0..10 {
            world.tiles.push(SnapshotTile { x: i, y: 0, asset_name: "grass".into(), layer: 0, variant: 0 });
        }
        assert!(!pkg.all_mechanical_prerequisites_met(&world));

        // 30 grass tiles — enough
        let mut world = WorldSnapshot::default();
        for i in 0..30 {
            world.tiles.push(SnapshotTile { x: i, y: 0, asset_name: "grass".into(), layer: 0, variant: 0 });
        }
        assert!(pkg.all_mechanical_prerequisites_met(&world));
    }

    #[test]
    fn package_serialization_roundtrip() {
        let pkg = soccer_package();
        let json = serde_json::to_string(&pkg).expect("serialize");
        let restored: RulesPackage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.id(), "soccer");
        assert_eq!(restored.name, "Playground Soccer");
        assert_eq!(restored.prerequisites.len(), 4);
        assert_eq!(restored.verifier_script.as_deref(), Some("soccer_verifier"));
    }

    #[test]
    fn requires_verifier_logic() {
        let def = GameDefinition::new("Test", GameMode::RealTime);

        // No verifier, no custom → false
        let pkg = RulesPackage::new("nv", "No Verifier", def.clone());
        assert!(!pkg.requires_verifier());

        // Has verifier script → true
        let pkg = RulesPackage::new("wv", "With Verifier", def.clone())
            .with_verifier("check");
        assert!(pkg.requires_verifier());

        // Has custom prerequisite (no verifier script) → true
        let pkg = RulesPackage::new("wc", "With Custom", def)
            .with_prerequisite(Prerequisite::Custom {
                key: "x".into(), description: "y".into(),
            });
        assert!(pkg.requires_verifier());
    }
}
