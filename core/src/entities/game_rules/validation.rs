//! Game definition validation — checks that a game can be played.
//!
//! Runs before game start. Returns a list of issues (errors and warnings).
//! Errors prevent the game from starting. Warnings are informational.

use super::definition::GameDefinition;

/// Severity of a validation issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueSeverity {
    Error,
    Warning,
}

/// A single validation issue.
#[derive(Debug, Clone)]
pub struct ValidationIssue {
    pub severity: IssueSeverity,
    pub message: String,
}

/// Result of validating a game definition.
#[derive(Debug, Clone)]
pub struct ValidationResult {
    pub issues: Vec<ValidationIssue>,
}

impl ValidationResult {
    pub fn is_playable(&self) -> bool {
        !self.issues.iter().any(|i| i.severity == IssueSeverity::Error)
    }

    pub fn errors(&self) -> Vec<&ValidationIssue> {
        self.issues.iter().filter(|i| i.severity == IssueSeverity::Error).collect()
    }

    pub fn warnings(&self) -> Vec<&ValidationIssue> {
        self.issues.iter().filter(|i| i.severity == IssueSeverity::Warning).collect()
    }
}

/// Validate a game definition and return all issues.
pub fn validate_game(def: &GameDefinition) -> ValidationResult {
    let mut issues = Vec::new();

    // Must have at least 2 teams
    if def.teams.len() < 2 {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            message: format!("Game needs at least 2 teams, found {}", def.teams.len()),
        });
    }

    // Must have at least one win condition
    if def.win_conditions.is_empty() {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            message: "No win conditions defined. The game cannot end.".into(),
        });
    }

    // Must have a rules script
    if def.rules_script.is_empty() {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            message: "No rules script defined.".into(),
        });
    }

    // Stat schema should have at least hp
    if !def.stat_schema.has("hp") {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Warning,
            message: "Stat schema has no 'hp' stat. Characters cannot take damage.".into(),
        });
    }

    // Character templates should exist for spawning
    if def.character_templates.is_empty() {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Warning,
            message: "No character templates defined. No units can be spawned.".into(),
        });
    }

    // Check for duplicate team IDs
    let mut seen_ids = std::collections::HashSet::new();
    for team in &def.teams {
        if !seen_ids.insert(team.id) {
            issues.push(ValidationIssue {
                severity: IssueSeverity::Error,
                message: format!("Duplicate team ID: {:?}", team.id),
            });
        }
    }

    // Check that character templates reference valid stats
    for tmpl in &def.character_templates {
        for stat_key in tmpl.base_stats.keys() {
            if !def.stat_schema.has(stat_key) {
                issues.push(ValidationIssue {
                    severity: IssueSeverity::Warning,
                    message: format!(
                        "Template '{}' has stat '{}' not in schema. It will work but won't be clamped or validated.",
                        tmpl.name, stat_key
                    ),
                });
            }
        }
    }

    // ── Mode-specific world binding validation ──────────────────────

    let wb = &def.world_binding;
    let has_spawns = wb.zones.iter().any(|z| matches!(z.zone_type, super::definition::ZoneType::SpawnPoint));

    if !has_spawns && !def.character_templates.is_empty() {
        issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            message: "No spawn points defined in world binding. Characters cannot be placed.".into(),
        });
    }

    match def.mode {
        super::types::GameMode::Tactical => {
            let has_encounters = wb.zones.iter().any(|z| matches!(z.zone_type, super::definition::ZoneType::EncounterArea));
            if !has_encounters {
                issues.push(ValidationIssue {
                    severity: IssueSeverity::Warning,
                    message: "Tactical mode but no encounter zones defined. Encounters will never trigger automatically.".into(),
                });
            }
        }
        super::types::GameMode::RealTime => {
            // Check for wave sources if any win condition is Survival
            let has_survival = def.win_conditions.iter().any(|w| matches!(w, super::definition::WinCondition::Survival { .. }));
            if has_survival {
                let has_wave_sources = wb.zones.iter().any(|z| matches!(z.zone_type, super::definition::ZoneType::WaveSource));
                if !has_wave_sources {
                    issues.push(ValidationIssue {
                        severity: IssueSeverity::Error,
                        message: "Survival win condition requires wave sources in world binding.".into(),
                    });
                }
                if wb.wave_paths.is_empty() {
                    issues.push(ValidationIssue {
                        severity: IssueSeverity::Error,
                        message: "Survival win condition requires wave paths for enemy movement.".into(),
                    });
                }
            }
        }
        super::types::GameMode::TurnBased => {
            // Turn-based: every team needs a spawn point if units will be spawned
            if !def.character_templates.is_empty() {
                for team in &def.teams {
                    let team_spawns = wb.zones.iter().any(|z|
                        matches!(z.zone_type, super::definition::ZoneType::SpawnPoint)
                        && z.team_id == Some(team.id)
                    );
                    if !team_spawns {
                        issues.push(ValidationIssue {
                            severity: IssueSeverity::Warning,
                            message: format!("Team '{}' has no assigned spawn point.", team.name),
                        });
                    }
                }
            }
        }
    }

    ValidationResult { issues }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::definition::*;
    use super::super::types::*;
    use super::super::team::*;

    #[test]
    fn empty_game_fails_validation() {
        let game = GameDefinition::new("Empty", GameMode::RealTime);
        let result = validate_game(&game);
        assert!(!result.is_playable());
        assert!(result.errors().len() >= 2); // no teams, no win conditions
    }

    #[test]
    fn valid_game_passes() {
        let mut game = GameDefinition::new("Valid", GameMode::RealTime);
        game.teams.push(TeamDefinition {
            id: TeamId(0), name: "A".into(),
            controller: TeamController::Human, color: "#fff".into(),
        });
        game.teams.push(TeamDefinition {
            id: TeamId(1), name: "B".into(),
            controller: TeamController::Cpu { script_name: "ai".into() },
            color: "#000".into(),
        });
        game.win_conditions.push(WinCondition::Elimination);
        game.stat_schema = StatSchema::new()
            .add(StatDef::new("hp", "HP").with_range(100.0, 0.0, 999.0));

        let result = validate_game(&game);
        assert!(result.is_playable());
        assert!(result.errors().is_empty());
    }

    #[test]
    fn no_hp_warns() {
        let mut game = GameDefinition::new("No HP", GameMode::TurnBased);
        game.teams.push(TeamDefinition {
            id: TeamId(0), name: "A".into(),
            controller: TeamController::Human, color: "#fff".into(),
        });
        game.teams.push(TeamDefinition {
            id: TeamId(1), name: "B".into(),
            controller: TeamController::Human, color: "#000".into(),
        });
        game.win_conditions.push(WinCondition::Elimination);

        let result = validate_game(&game);
        assert!(result.is_playable()); // warning, not error
        assert_eq!(result.warnings().len(), 2); // no hp + no templates
    }

    #[test]
    fn templates_without_spawns_is_error() {
        use super::super::character::*;
        use super::super::resource::*;

        let mut game = GameDefinition::new("No Spawns", GameMode::TurnBased);
        game.teams.push(TeamDefinition {
            id: TeamId(0), name: "A".into(),
            controller: TeamController::Human, color: "#fff".into(),
        });
        game.teams.push(TeamDefinition {
            id: TeamId(1), name: "B".into(),
            controller: TeamController::Human, color: "#000".into(),
        });
        game.win_conditions.push(WinCondition::Elimination);
        game.stat_schema = StatSchema::new()
            .add(StatDef::new("hp", "HP").with_range(100.0, 0.0, 999.0));
        game.character_templates.push(CharacterTemplate {
            id: TemplateId("marine".into()),
            name: "Marine".into(),
            body_def_id: "carnat_test".into(),
            base_stats: game.stat_schema.default_stats(),
            weapon_def_id: None,
            throwable_def_id: None,
            tags: vec![],
        });
        // No spawn points in world binding

        let result = validate_game(&game);
        assert!(!result.is_playable()); // error: templates exist but no spawns
        // Per-team warnings also fire
        assert!(result.warnings().iter().any(|w| w.message.contains("Team 'A'")));
        assert!(result.warnings().iter().any(|w| w.message.contains("Team 'B'")));
    }

    #[test]
    fn with_spawns_is_playable() {
        use super::super::character::*;

        let mut game = GameDefinition::new("With Spawns", GameMode::TurnBased);
        game.teams.push(TeamDefinition {
            id: TeamId(0), name: "A".into(),
            controller: TeamController::Human, color: "#fff".into(),
        });
        game.teams.push(TeamDefinition {
            id: TeamId(1), name: "B".into(),
            controller: TeamController::Human, color: "#000".into(),
        });
        game.win_conditions.push(WinCondition::Elimination);
        game.stat_schema = StatSchema::new()
            .add(StatDef::new("hp", "HP").with_range(100.0, 0.0, 999.0));
        game.character_templates.push(CharacterTemplate {
            id: TemplateId("marine".into()),
            name: "Marine".into(),
            body_def_id: "carnat_test".into(),
            base_stats: game.stat_schema.default_stats(),
            weapon_def_id: None,
            throwable_def_id: None,
            tags: vec![],
        });
        // Add spawn points for both teams
        game.world_binding.zones.push(Zone {
            name: "spawn_a".into(), x: 0, y: 0, width: 5, height: 5,
            zone_type: ZoneType::SpawnPoint, team_id: Some(TeamId(0)),
        });
        game.world_binding.zones.push(Zone {
            name: "spawn_b".into(), x: 10, y: 10, width: 5, height: 5,
            zone_type: ZoneType::SpawnPoint, team_id: Some(TeamId(1)),
        });

        let result = validate_game(&game);
        assert!(result.is_playable());
        assert!(result.errors().is_empty());
    }
}
