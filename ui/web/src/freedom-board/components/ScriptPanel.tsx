import { useState, useEffect, useCallback, useRef } from 'react';
import { scriptStore } from '../../lib/idb';
import type { ScriptScope, ScriptRecord } from '../../lib/idb';
import { RhaiEditor } from './RhaiEditor';

// ── Types ─────────────────────────────────────────────────────────────

interface ScriptEntry {
  name: string;
  scope: ScriptScope;
  source: string;
  updatedAt: number;
}

interface ScriptPanelProps {
  /** Send scripts to WASM via reload_scripts worker message. */
  onReloadScripts: (scriptsJson: string) => void;
  /** Panel is read-only during play mode. */
  disabled?: boolean;
}

// ── Scope metadata ────────────────────────────────────────────────────

const SCOPE_LABELS: Record<ScriptScope, string> = {
  rules: 'Rules',
  character_ai: 'Character AI',
  world_gen: 'World Gen',
};

const SCOPE_COLORS: Record<ScriptScope, string> = {
  rules: '#e0a060',
  character_ai: '#60a0e0',
  world_gen: '#4ecca3',
};

const SCOPE_ORDER: ScriptScope[] = ['rules', 'character_ai', 'world_gen'];

// ── Starter templates ─────────────────────────────────────────────────
// Minimal valid scripts so the user doesn't start from a blank page.

const SCOPE_TEMPLATES: Record<ScriptScope, string> = {
  rules: `// Rules script — called once per game event
fn on_event(ctx) {
    let name = ctx.event_name;

    if name == "GameStart" {
        cmd_log(ctx, "Game started!");
    }

    if name == "Tick" {
        let dt = event_data(ctx, "dt");
        // Per-frame logic here
    }
}
`,
  character_ai: `// Character AI — called every frame for this character
fn update(ctx) {
    let me = self_pos(ctx);
    let enemy = find_nearest(ctx, "enemy");

    if enemy >= 0 {
        let pos = get_position(ctx, enemy);
        let d = dist_vec(me, pos);
        if d < 1.5 {
            attack(ctx, enemy);
        } else if d < 20.0 {
            move_to(ctx, pos.x, pos.y);
        }
    }
}
`,
  world_gen: `// World gen — called once during Setup phase
fn generate(ctx) {
    // Place a 5x5 grass field
    for x in range(0, 5) {
        for y in range(0, 5) {
            cmd_place_tile(ctx, x, y, "iarba", 0, 0);
        }
    }
    cmd_log(ctx, "World generated!");
}
`,
};

// ── Example scripts ───────────────────────────────────────────────────
// Pre-built scripts that work end-to-end in the current runtime.
// Only scopes with wired engines are included (rules, character_ai).
// World gen examples will be added when Track E (WorldGenContext) ships.

const EXAMPLE_SCRIPTS: Array<{ name: string; scope: ScriptScope; source: string }> = [
  {
    name: 'example_rules',
    scope: 'rules',
    source: `// Example: Gold production + elimination win condition
// Works with any GameDefinition that has two teams (id 0 and 1).
fn on_event(ctx) {
    let name = ctx.event_name;

    if name == "GameStart" {
        cmd_log(ctx, "=== Battle begins! ===");
        // Spawn one marine per team at fixed positions
        cmd_spawn(ctx, "marine", 0, 3.0, 3.0);
        cmd_spawn(ctx, "marine", 1, 12.0, 12.0);
    }

    if name == "Tick" {
        // Each team earns 1 gold per second
        let dt = event_data(ctx, "dt");
        cmd_modify_resource(ctx, 0, "gold", dt * 1.0);
        cmd_modify_resource(ctx, 1, "gold", dt * 1.0);
    }

    if name == "UnitKilled" {
        // Check for elimination
        let team_0_alive = query_alive_count(ctx, 0);
        let team_1_alive = query_alive_count(ctx, 1);
        if team_0_alive == 0 {
            cmd_log(ctx, "Team 1 wins by elimination!");
            cmd_end_game(ctx, 1);
        }
        if team_1_alive == 0 {
            cmd_log(ctx, "Team 0 wins by elimination!");
            cmd_end_game(ctx, 0);
        }
    }
}
`,
  },
  {
    name: 'example_chase_ai',
    scope: 'character_ai',
    source: `// Example: Chase nearest enemy, attack when close
fn update(ctx) {
    let me = self_pos(ctx);
    let enemy = find_nearest(ctx, "enemy");

    if enemy < 0 {
        // No enemies visible — idle
        set_animation(ctx, "idle");
        return;
    }

    let pos = get_position(ctx, enemy);
    let d = dist_vec(me, pos);

    if d < 1.5 {
        // In melee range — attack
        attack(ctx, enemy);
        set_animation(ctx, "melee");
    } else if d < 15.0 {
        // Chase
        move_to(ctx, pos.x, pos.y);
        set_animation(ctx, "walk");
    } else {
        // Too far — ignore
        set_animation(ctx, "idle");
    }
}
`,
  },
  {
    name: 'example_patrol_ai',
    scope: 'character_ai',
    source: `// Example: Patrol between two waypoints
// Uses a simple toggle based on proximity to target.
fn update(ctx) {
    let me = self_pos(ctx);

    // Two patrol waypoints
    let ax = 3.0;
    let ay = 3.0;
    let bx = 12.0;
    let by = 12.0;

    // Walk toward whichever waypoint is farther
    let da = dist(me.x, me.y, ax, ay);
    let db = dist(me.x, me.y, bx, by);

    if da < 1.0 {
        // Reached A, go to B
        move_to(ctx, bx, by);
    } else if db < 1.0 {
        // Reached B, go to A
        move_to(ctx, ax, ay);
    } else if da < db {
        // Closer to A, keep going to A (will flip on arrival)
        move_to(ctx, ax, ay);
    } else {
        move_to(ctx, bx, by);
    }

    set_animation(ctx, "walk");
}
`,
  },
];

// ── Component ─────────────────────────────────────────────────────────

export function ScriptPanel({ onReloadScripts, disabled = false }: ScriptPanelProps) {
  // Script list from IDB
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Editor state — decoupled from IDB until explicit save
  const [editSource, setEditSource] = useState('');
  const [editScope, setEditScope] = useState<ScriptScope>('rules');
  const [dirty, setDirty] = useState(false);

  // UI state
  const [status, setStatus] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState<ScriptScope>('rules');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────

  /** Show a transient status message for 3 seconds. */
  const flash = useCallback((msg: string) => {
    setStatus(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus(null), 3000);
  }, []);

  /** Load all scripts from IDB. */
  const refreshList = useCallback(async () => {
    const all = await scriptStore.getAll();
    const entries: ScriptEntry[] = all.map(({ key, value }) => ({
      name: key,
      scope: (value as ScriptRecord).scope,
      source: (value as ScriptRecord).source,
      updatedAt: (value as ScriptRecord).updatedAt,
    }));
    // Sort: rules first, then character_ai, then world_gen, alphabetical within scope
    entries.sort((a, b) => {
      const si = SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope);
      if (si !== 0) return si;
      return a.name.localeCompare(b.name);
    });
    setScripts(entries);
    return entries;
  }, []);

  // ── Error helper ─────────────────────────────────────────────────
  // Every IDB operation can reject (blocked upgrade, quota, corruption).
  // Callers use this to surface failures in the status bar instead of
  // silently swallowing them as unhandled promise rejections.

  const flashError = useCallback((context: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scripts] ${context}:`, err);
    flash(`ERROR: ${context} — ${msg}`);
  }, [flash]);

  // ── Load on mount ───────────────────────────────────────────────

  useEffect(() => {
    refreshList()
      .then(entries => {
        if (entries.length > 0 && !selectedName) {
          selectScript(entries[0]);
        }
      })
      .catch(err => flashError('Failed to load script list', err));
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Script selection ────────────────────────────────────────────

  const selectScript = useCallback((entry: ScriptEntry) => {
    setSelectedName(entry.name);
    setEditSource(entry.source);
    setEditScope(entry.scope);
    setDirty(false);
    setShowNewForm(false);
    setRenaming(null);
  }, []);

  const handleSelectScript = useCallback((name: string) => {
    if (dirty) {
      const proceed = window.confirm('Unsaved changes will be lost. Switch anyway?');
      if (!proceed) return;
    }
    const entry = scripts.find(s => s.name === name);
    if (entry) selectScript(entry);
  }, [dirty, scripts, selectScript]);

  // ── Create ──────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;

    try {
      const existing = await scriptStore.load(trimmed);
      if (existing) {
        flash(`"${trimmed}" already exists`);
        return;
      }

      const source = SCOPE_TEMPLATES[newScope];
      await scriptStore.save(trimmed, source, newScope);
      const entries = await refreshList();
      const created = entries.find(e => e.name === trimmed);
      if (created) selectScript(created);

      setShowNewForm(false);
      setNewName('');
      flash(`Created "${trimmed}"`);
    } catch (err) {
      flashError('Create failed', err);
    }
  }, [newName, newScope, refreshList, selectScript, flash, flashError]);

  // ── Load examples ───────────────────────────────────────────────

  const handleLoadExamples = useCallback(async () => {
    try {
      let created = 0;
      let firstName: string | null = null;
      for (const ex of EXAMPLE_SCRIPTS) {
        const existing = await scriptStore.load(ex.name);
        if (!existing) {
          await scriptStore.save(ex.name, ex.source, ex.scope);
          if (!firstName) firstName = ex.name;
          created++;
        }
      }
      if (created === 0) {
        flash('Examples already exist');
        return;
      }
      const entries = await refreshList();
      const target = entries.find(e => e.name === firstName);
      if (target) selectScript(target);
      flash(`Created ${created} example script(s)`);
    } catch (err) {
      flashError('Load examples failed', err);
    }
  }, [refreshList, selectScript, flash, flashError]);

  // ── Save ────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!selectedName) return;
    try {
      await scriptStore.save(selectedName, editSource, editScope);
      setDirty(false);
      setScripts(prev => prev.map(s =>
        s.name === selectedName
          ? { ...s, source: editSource, scope: editScope, updatedAt: Date.now() }
          : s
      ));
      flash('Saved');
    } catch (err) {
      flashError('Save failed', err);
    }
  }, [selectedName, editSource, editScope, flash, flashError]);

  // ── Delete ──────────────────────────────────────────────────────

  const handleDelete = useCallback(async (name: string) => {
    const proceed = window.confirm(
      `Delete script "${name}"?\n\n` +
      'WARNING: If any GameDefinition or CharacterInstance references ' +
      'this script name, those references will become dangling.'
    );
    if (!proceed) return;

    try {
      await scriptStore.delete(name);
      const entries = await refreshList();

      if (selectedName === name) {
        if (entries.length > 0) {
          selectScript(entries[0]);
        } else {
          setSelectedName(null);
          setEditSource('');
          setDirty(false);
        }
      }

      flash(`Deleted "${name}"`);
    } catch (err) {
      flashError('Delete failed', err);
    }
  }, [selectedName, refreshList, selectScript, flash, flashError]);

  // ── Rename ──────────────────────────────────────────────────────

  const handleRenameStart = useCallback((name: string) => {
    setRenaming(name);
    setRenameValue(name);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renaming) {
      setRenaming(null);
      return;
    }

    const proceed = window.confirm(
      `Rename "${renaming}" to "${trimmed}"?\n\n` +
      'WARNING: Any GameDefinition, team controller, or character that ' +
      `references "${renaming}" will need to be updated manually. ` +
      'References are NOT updated automatically.'
    );
    if (!proceed) {
      setRenaming(null);
      return;
    }

    try {
      await scriptStore.rename(renaming, trimmed);
      const entries = await refreshList();
      if (selectedName === renaming) {
        const renamed = entries.find(e => e.name === trimmed);
        if (renamed) selectScript(renamed);
      }
      setRenaming(null);
      flash(`Renamed to "${trimmed}"`);
    } catch (err) {
      flashError('Rename failed', err);
      setRenaming(null);
    }
  }, [renaming, renameValue, selectedName, refreshList, selectScript, flash, flashError]);

  // ── Reload to WASM ──────────────────────────────────────────────

  const handleReload = useCallback(async () => {
    try {
      const all = await scriptStore.getAll();
      const scriptsMap: Record<string, { source: string; scope: string }> = {};
      for (const { key, value } of all) {
        const rec = value as ScriptRecord;
        scriptsMap[key] = { source: rec.source, scope: rec.scope };
      }
      if (selectedName && dirty) {
        scriptsMap[selectedName] = { source: editSource, scope: editScope };
      }
      const json = JSON.stringify(scriptsMap);
      onReloadScripts(json);
      const count = Object.keys(scriptsMap).length;
      flash(`Reloaded ${count} script(s) to WASM${dirty ? ' (incl. unsaved)' : ''}`);
    } catch (err) {
      flashError('Reload failed', err);
    }
  }, [onReloadScripts, selectedName, editSource, editScope, dirty, flash, flashError]);

  // ── Editor change handler ──────────────────────────────────────

  const handleEditorChange = useCallback((newValue: string) => {
    setEditSource(newValue);
    setDirty(true);
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────

  const handleKeyDown = useCallback((ev: React.KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
      ev.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  // ── Render ──────────────────────────────────────────────────────

  const selected = scripts.find(s => s.name === selectedName);

  return (
    <div
      style={{
        width: 360,
        display: 'flex',
        flexDirection: 'column',
        background: '#0d1525',
        borderLeft: '1px solid #1a2a4a',
        fontSize: 12,
        userSelect: 'none',
      }}
      onKeyDown={handleKeyDown}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{
        padding: '6px 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid #1a2a4a',
        background: '#16213e',
      }}>
        <span style={{ color: '#8899aa', fontWeight: 600, fontSize: 11, letterSpacing: 0.5 }}>
          SCRIPTS
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => { setShowNewForm(v => !v); setRenaming(null); }}
            disabled={disabled}
            style={smallBtnStyle(disabled)}
            title="New script"
          >
            +
          </button>
          <button
            onClick={handleLoadExamples}
            disabled={disabled}
            style={smallBtnStyle(disabled)}
            title="Create example scripts (skips if names already exist)"
          >
            Examples
          </button>
          <button
            onClick={handleReload}
            disabled={disabled}
            style={{
              ...smallBtnStyle(disabled),
              color: disabled ? '#445566' : '#4ecca3',
              border: '1px solid #2a4a3a',
            }}
            title="Reload all scripts into WASM"
          >
            Reload
          </button>
        </div>
      </div>

      {/* ── New script form ────────────────────────────────────── */}
      {showNewForm && (
        <div style={{
          padding: '6px 10px',
          borderBottom: '1px solid #1a2a4a',
          background: '#0f1a2e',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}>
          <input
            type="text"
            placeholder="Script name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewForm(false); }}
            autoFocus
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <select
              value={newScope}
              onChange={e => setNewScope(e.target.value as ScriptScope)}
              style={{ ...inputStyle, flex: 1 }}
            >
              {SCOPE_ORDER.map(s => (
                <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
              ))}
            </select>
            <button onClick={handleCreate} style={smallBtnStyle(false)}>Create</button>
            <button onClick={() => setShowNewForm(false)} style={smallBtnStyle(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Script list ────────────────────────────────────────── */}
      <div style={{
        maxHeight: 200,
        overflowY: 'auto',
        borderBottom: '1px solid #1a2a4a',
      }}>
        {scripts.length === 0 ? (
          <div style={{ padding: '12px 10px', color: '#445566', fontStyle: 'italic' }}>
            No scripts yet. Click + to create one.
          </div>
        ) : (
          scripts.map(entry => (
            <div
              key={entry.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 10px',
                background: selectedName === entry.name ? '#1a2a4a' : 'transparent',
                cursor: disabled ? 'not-allowed' : 'pointer',
                borderBottom: '1px solid #0a0f1a',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {renaming === entry.name ? (
                <input
                  type="text"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRenameConfirm(); if (e.key === 'Escape') setRenaming(null); }}
                  onBlur={handleRenameConfirm}
                  autoFocus
                  style={{ ...inputStyle, flex: 1, fontSize: 11 }}
                />
              ) : (
                <>
                  <div
                    onClick={() => !disabled && handleSelectScript(entry.name)}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span style={{
                      fontSize: 9,
                      padding: '1px 4px',
                      borderRadius: 2,
                      background: SCOPE_COLORS[entry.scope] + '22',
                      color: SCOPE_COLORS[entry.scope],
                      fontWeight: 600,
                    }}>
                      {SCOPE_LABELS[entry.scope].slice(0, 3).toUpperCase()}
                    </span>
                    <span style={{
                      color: selectedName === entry.name ? '#ccc' : '#8899aa',
                      fontSize: 11,
                    }}>
                      {entry.name}
                    </span>
                    {selectedName === entry.name && dirty && (
                      <span style={{ color: '#e94560', fontSize: 9 }}>*</span>
                    )}
                  </div>
                  {!disabled && selectedName === entry.name && (
                    <div style={{ display: 'flex', gap: 2 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRenameStart(entry.name); }}
                        style={tinyBtnStyle}
                        title="Rename"
                      >
                        ren
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(entry.name); }}
                        style={{ ...tinyBtnStyle, color: '#e94560' }}
                        title="Delete"
                      >
                        del
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── Scope selector for selected script ─────────────────── */}
      {selected && (
        <div style={{
          padding: '4px 10px',
          borderBottom: '1px solid #1a2a4a',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span style={{ color: '#556677', fontSize: 10 }}>Scope:</span>
          <select
            value={editScope}
            onChange={e => { setEditScope(e.target.value as ScriptScope); setDirty(true); }}
            disabled={disabled}
            style={{ ...inputStyle, fontSize: 10, padding: '1px 4px' }}
          >
            {SCOPE_ORDER.map(s => (
              <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
            ))}
          </select>
          <span style={{
            marginLeft: 'auto',
            color: '#445566',
            fontSize: 9,
          }}>
            {selected.name}
          </span>
        </div>
      )}

      {/* ── Editor (CodeMirror 6 via RhaiEditor) ────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {selectedName ? (
          <RhaiEditor
            value={editSource}
            onChange={handleEditorChange}
            readOnly={disabled}
          />
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#334455',
            fontStyle: 'italic',
          }}>
            {scripts.length === 0 ? 'Create a script to begin' : 'Select a script'}
          </div>
        )}
      </div>

      {/* ── Bottom bar: Save + status ──────────────────────────── */}
      <div style={{
        padding: '4px 10px',
        borderTop: '1px solid #1a2a4a',
        background: '#16213e',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <button
          onClick={handleSave}
          disabled={disabled || !selectedName || !dirty}
          style={{
            padding: '3px 10px',
            background: dirty && selectedName ? '#1a3a1a' : '#1a1a2a',
            color: dirty && selectedName ? '#4ecca3' : '#445566',
            border: `1px solid ${dirty && selectedName ? '#2a5a2a' : '#222'}`,
            borderRadius: 3,
            cursor: dirty && selectedName && !disabled ? 'pointer' : 'default',
            fontSize: 11,
          }}
          title="Save to IDB (Ctrl+S)"
        >
          Save
        </button>
        <span style={{ color: '#556677', fontSize: 10 }}>
          {status ?? (dirty ? 'unsaved changes' : selectedName ? 'saved' : '')}
        </span>
        <span style={{ marginLeft: 'auto', color: '#334455', fontSize: 9 }}>
          Ctrl+S save
        </span>
      </div>
    </div>
  );
}

// ── Shared inline styles ──────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: '#0f0f23',
  border: '1px solid #333',
  borderRadius: 3,
  padding: '3px 6px',
  color: '#ccc',
  fontSize: 11,
  outline: 'none',
};

function smallBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '2px 8px',
    background: '#1a2a4a',
    color: disabled ? '#445566' : '#8899aa',
    border: '1px solid #2a3a5a',
    borderRadius: 3,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 11,
    opacity: disabled ? 0.5 : 1,
  };
}

const tinyBtnStyle: React.CSSProperties = {
  padding: '1px 4px',
  background: 'transparent',
  color: '#556677',
  border: '1px solid transparent',
  borderRadius: 2,
  cursor: 'pointer',
  fontSize: 9,
};
