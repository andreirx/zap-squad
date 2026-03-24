# wasm-validator

WASM adapter that exposes `core/entities/game_rules/validation.rs` through a JSON DTO boundary.

## Purpose

The Rules Editor (`ui/web/src/editors/RulesEditor/`) needs to validate `GameDefinition` JSON
against the authoritative Rust validator. This crate provides that bridge without pulling in
the full game/rendering runtime (wasm-canvas).

## Architecture

```
core/entities/game_rules/validation.rs   <-- owns validate_game()
         |
infrastructure/wasm-validator/           <-- THIS: WASM adapter, DTO mapping
         |
ui/web/src/editors/RulesEditor/          <-- consumes DTO JSON, displays issues
```

**Dependency rule**: wasm-validator depends on `zapsquad-core` only. No adapters, no zap-engine,
no rendering dependencies. This keeps the WASM binary small (~170KB) and the boundary clean.

## Exports

| Export | Description |
|--------|-------------|
| `init_validator()` | Set up panic hook for browser error messages |
| `validate_game_json(json: &str) -> String` | Parse JSON → validate → return DTO JSON |

## DTO Contract

**Input**: JSON string matching `GameDefinition` (see `core/entities/game_rules/definition.rs`)

**Output**: JSON string:
```json
{
  "playable": true,
  "issues": [
    { "severity": "error", "message": "Game needs at least 2 teams, found 0" },
    { "severity": "warning", "message": "Stat schema has no 'hp' stat." }
  ]
}
```

Parse errors are returned as validation issues (`severity: "error"`), never as panics.

## Build

```
make wasm-validator
```

Output: `ui/web/src/wasm-validator/`

## Maturity

**PROTOTYPE** — Crate is structurally complete but not yet tested end-to-end in the browser.
Promote to MATURE after confirming the Rules Editor loads and displays validation results correctly.
