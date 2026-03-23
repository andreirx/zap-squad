# Game Rules Domain — Remaining Work

## Status: Core types, three-scope script bindings, world binding, time model, session init implemented (2026-03-23).

## Resolved

- ~~Serialization~~ — All domain types derive `Serialize`/`Deserialize`. DONE.
- ~~Deterministic turn order~~ — `GameSession.teams` is `Vec<TeamState>`, turn rotation asserted. DONE.
- ~~Domain-level character identity~~ — `CharacterInstanceId(u32)` decoupled from `ActorId`. DONE.
- ~~Script mutation boundary~~ — Three isolated scopes with separate command enums. DONE.
- ~~World binding~~ — `GameDefinition` has `WorldBinding` with zones, wave paths, world name. DONE.
- ~~Starting resources~~ — `GameSession::from_definition()` applies schema starting amounts. DONE.
- ~~Time model~~ — Events split: `Tick{dt}`, `TurnStart/End`, `PlanningStart/End`, `ResolutionStart/End`. DONE.

## P1 — Must fix before the rules system is usable

### WorldGenCommand cannot express zone semantics
`WorldGenCommand::DefineZone` only carries name + rectangle. `WorldBinding::Zone` requires
`zone_type` (SpawnPoint, EncounterArea, WaveSource, etc.) and optional `team_id`.
A world generation script cannot create typed zones that validation can use.
**Fix:** Extend `WorldGenCommand::DefineZone` to include `zone_type: String` and
`team_id: Option<u32>`. The orchestrator maps the string to `ZoneType` enum.
**Files:** `game_script_bindings.rs`, orchestrator (future wasm-canvas integration)

### Turn-based validation too weak
If no spawn points exist at all, only a generic warning fires and per-team checks
are skipped. A turn-based game with teams and templates but zero spawn points
validates as playable.
**Fix:** Make "no spawn points" an Error (not Warning) when character templates exist.
The per-team check should run regardless of global spawn presence.
**Files:** `validation.rs`

## P2 — Important, can iterate

### Resource production model
`ResourceDef` names a resource type but has no production/consumption rules.
`ZoneType::ResourceProducer` exists but no model for rate ticking, worker assignment,
capacity, or depletion beyond what the rules script implements manually.
**Fix:** Production rules are intentionally script-driven (not engine-enforced).
Document this as a design decision, not a gap. Rules scripts call
`cmd_modify_resource()` on each `Tick` event for production.

### Mode-specific validation depth
Validation catches structural issues but not economic closure (can resources be
produced AND spent?), template reachability (can all templates actually spawn?),
or script availability (do referenced scripts exist?).
**Fix:** Incremental — add checks as real game definitions expose gaps.

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
