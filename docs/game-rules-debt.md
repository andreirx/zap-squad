# Game Rules Domain — Remaining Work

## Status: Core types, three-scope script bindings, world binding, time model, session init,
## game rules editor, WASM validation bridge all implemented (2026-03-24).

## Resolved

- ~~Serialization~~ — All domain types derive `Serialize`/`Deserialize`. DONE.
- ~~Deterministic turn order~~ — `GameSession.teams` is `Vec<TeamState>`, turn rotation asserted. DONE.
- ~~Domain-level character identity~~ — `CharacterInstanceId(u32)` decoupled from `ActorId`. DONE.
- ~~Script mutation boundary~~ — Three isolated scopes with separate command enums. DONE.
- ~~World binding~~ — `GameDefinition` has `WorldBinding` with zones, wave paths, world name. DONE.
- ~~Starting resources~~ — `GameSession::from_definition()` applies schema starting amounts. DONE.
- ~~Time model~~ — Events split: `Tick{dt}`, `TurnStart/End`, `PlanningStart/End`, `ResolutionStart/End`. DONE.
- ~~Turn-based validation~~ — "No spawn points" is an Error when templates exist (line 117, `validation.rs`). Per-team spawn check runs independently. Tests confirm `templates_without_spawns_is_error`. DONE.
- ~~Rules editor serialization~~ — TeamController, WinCondition, ZoneType all match serde externally tagged contract. DONE.
- ~~Rules editor authoring surface~~ — All 10 sections: basics, teams, stats, resources, templates, win conditions, scripts, world binding, validation, JSON preview. DONE.
- ~~WASM validation~~ — `wasm-validator` crate exposes `validate_game_json()`, Rules Editor consumes DTO. DONE.

## P1 — Must fix before the rules system is usable in play

### WorldGenCommand zone_type is a raw String
`WorldGenCommand::DefineZone` carries `zone_type: String` and `team_id: Option<u32>`.
The orchestrator must map the string to the `ZoneType` enum when applying commands.
This is not a code bug — the string transport is intentional at the script boundary.
But the orchestrator must implement the mapping correctly, including parsing
`"resource_producer:key:rate"` format for `ZoneType::ResourceProducer`.
**Files:** `game_script_bindings.rs` (line 106-114), orchestrator (future)

## P2 — Important, can iterate

### Resource production model
`ResourceDef` names a resource type but has no production/consumption rules.
`ZoneType::ResourceProducer` exists but no model for rate ticking, worker assignment,
capacity, or depletion beyond what the rules script implements manually.
**Decision:** Production rules are intentionally script-driven (not engine-enforced).
Rules scripts call `cmd_modify_resource()` on each `Tick` event for production.
This is a design decision, not a gap.

### Mode-specific validation depth
Validation catches structural issues but not economic closure (can resources be
produced AND spent?), template reachability (can all templates actually spawn?),
or script availability (do referenced scripts exist?).
**Fix:** Incremental — add checks as real game definitions expose gaps.
Script existence validation should be an orchestrator pre-flight check at game start.

### Pre-existing IDB definitions use old serialization
Game definitions saved before the serialization fixes (TeamController `{Human:true}`,
WinCondition `{type:'Elimination'}`) will fail validation until re-saved. No migration
needed — the feature is pre-release and no user data exists.

## What is solid

- Flexible stat schema (HashMap, schema-defined, visibility, clamping)
- Team model (human/CPU, deterministic order, starting resources)
- Template vs instance characters (fungible + individual, domain ID)
- Resource schema (game-mode-defined, starting amounts applied)
- World binding (zones with typed purposes, wave paths, world reference)
- Mode-specific validation (tactical needs encounters, survival needs waves, turn-based checks spawns)
- Session lifecycle (from_definition, phase transitions, turn rotation, event queue)
- Time model (Tick for real-time, TurnStart/End for discrete, Planning/Resolution for tactical)
- Three isolated Rhai scopes (AI, Rules, WorldGen) with command-based mutation
- All types serializable
- Complete authoring UI with typed serde-compatible serialization
- Authoritative WASM validation (single source of truth in Rust core)
