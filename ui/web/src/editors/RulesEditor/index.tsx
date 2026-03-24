import { useState, useCallback, useEffect, useRef } from 'react';
import { gameDefStore, worldStore } from '../../lib/idb';
import { createStorage } from '../../storage';

/**
 * Game Rules Editor — defines a playable game type.
 *
 * Output: a GameDefinition JSON saved to IDB.
 * Matches core/entities/game_rules/definition.rs structure.
 *
 * Sections:
 * 1. Game basics (name, description, mode)
 * 2. Teams (add/remove, human/CPU, color, AI script)
 * 3. Stat schema (add/remove stats with defaults/ranges/visibility)
 * 4. Resource schema (add/remove resources with starting amounts)
 * 5. Character templates (link to character assets, set base stats, equipment, tags)
 * 6. Win conditions (serde externally-tagged enum shape)
 * 7. Scripts (rules script, world gen script)
 * 8. World binding (zones, wave paths, target world — form-based; canvas overlay later)
 * 9. Validation (via wasm-validator WASM module — runs core validate_game())
 * 10. JSON preview
 */

type GameMode = 'RealTime' | 'Tactical' | 'TurnBased';
// Matches serde's externally tagged enum: "Human" (bare string) or {"Cpu":{"script_name":"..."}}
type TeamController = 'Human' | { Cpu: { script_name: string } };

interface TeamDef {
  id: number;
  name: string;
  controller: TeamController;
  color: string;
}

interface StatDef {
  key: string;
  display_name: string;
  default_value: number;
  min_value: number;
  max_value: number;
  visible: boolean;
  visible_to_enemies: boolean;
}

interface ResourceDef {
  key: string;
  display_name: string;
  starting_amount: number;
  max_amount: number;
  map_object_id: string | null;
  icon_id: string | null;
}

interface CharTemplate {
  id: string;
  name: string;
  body_def_id: string;
  base_stats: Record<string, number>;
  weapon_def_id: string | null;
  throwable_def_id: string | null;
  tags: string[];
}

// Matches serde's externally tagged enum:
//   "Elimination"  (bare string for unit variant)
//   {"Survival":{"turns_or_waves":10}}  (object for struct variants)
//   {"ResourceThreshold":{"resource_key":"gold","amount":100}}
//   {"Custom":{"condition_name":"foo"}}
type WinCondition =
  | 'Elimination'
  | { Survival: { turns_or_waves: number } }
  | { ResourceThreshold: { resource_key: string; amount: number } }
  | { Custom: { condition_name: string } };

function getWcType(wc: WinCondition): string {
  if (typeof wc === 'string') return wc;
  if ('Survival' in wc) return 'Survival';
  if ('ResourceThreshold' in wc) return 'ResourceThreshold';
  if ('Custom' in wc) return 'Custom';
  return 'unknown';
}

function makeWinCondition(type: string): WinCondition {
  switch (type) {
    case 'Survival': return { Survival: { turns_or_waves: 10 } };
    case 'ResourceThreshold': return { ResourceThreshold: { resource_key: '', amount: 100 } };
    case 'Custom': return { Custom: { condition_name: '' } };
    default: return 'Elimination';
  }
}

// ── World Binding types ──────────────────────────────────────────────
// Matches serde's externally tagged enum for ZoneType:
//   "SpawnPoint" (bare string for unit variants)
//   {"ResourceProducer":{"resource_key":"gold","rate":1.0}} (struct variant)
type ZoneType =
  | 'SpawnPoint'
  | 'EncounterArea'
  | 'ExtractionPoint'
  | 'WaveSource'
  | { ResourceProducer: { resource_key: string; rate: number } }
  | 'Custom';

interface ZoneDef {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zone_type: ZoneType;
  team_id: number | null;  // TeamId(u32) serializes as bare number
}

interface WavePathDef {
  name: string;
  waypoints: [number, number][];  // (i32, i32) tuples serialize as 2-element arrays
}

interface WorldBindingDef {
  zones: ZoneDef[];
  wave_paths: WavePathDef[];
  world_name: string | null;
}

function getZoneTypeName(zt: ZoneType): string {
  if (typeof zt === 'string') return zt;
  if ('ResourceProducer' in zt) return 'ResourceProducer';
  return 'Custom';
}

function makeZoneType(type: string): ZoneType {
  switch (type) {
    case 'SpawnPoint': return 'SpawnPoint';
    case 'EncounterArea': return 'EncounterArea';
    case 'ExtractionPoint': return 'ExtractionPoint';
    case 'WaveSource': return 'WaveSource';
    case 'ResourceProducer': return { ResourceProducer: { resource_key: '', rate: 1.0 } };
    default: return 'Custom';
  }
}

const ZONE_TYPE_LABELS: Record<string, string> = {
  SpawnPoint: 'Spawn Point — characters placed here',
  EncounterArea: 'Encounter Area — triggers auto-pause (Tactical)',
  ExtractionPoint: 'Extraction Point — objective zone',
  WaveSource: 'Wave Source — enemies spawn here (tower defense)',
  ResourceProducer: 'Resource Producer — generates resources',
  Custom: 'Custom — script-defined purpose',
};

/** DTO returned by wasm-validator. Matches ValidationResultDto in Rust. */
interface ValidationResultDto {
  playable: boolean;
  issues: { severity: 'error' | 'warning'; message: string }[];
}

interface GameDefinition {
  name: string;
  description: string;
  mode: GameMode;
  teams: TeamDef[];
  stat_schema: { stats: StatDef[] };
  resource_schema: { resources: ResourceDef[] };
  character_templates: CharTemplate[];
  win_conditions: WinCondition[];
  rules_script: string;
  world_gen_script: string | null;
  world_binding: WorldBindingDef;
}

const DEFAULT_DEF: GameDefinition = {
  name: 'New Game',
  description: '',
  mode: 'Tactical',
  teams: [
    { id: 0, name: 'Player', controller: 'Human', color: '#4ecca3' },
    { id: 1, name: 'Enemy', controller: { Cpu: { script_name: 'enemy_ai' } }, color: '#e94560' },
  ],
  stat_schema: {
    stats: [
      { key: 'hp', display_name: 'Hit Points', default_value: 100, min_value: 0, max_value: 999, visible: true, visible_to_enemies: false },
      { key: 'ap', display_name: 'Action Points', default_value: 4, min_value: 0, max_value: 10, visible: true, visible_to_enemies: false },
    ],
  },
  resource_schema: { resources: [] },
  character_templates: [],
  win_conditions: ['Elimination'],
  rules_script: 'default_rules',
  world_gen_script: null,
  world_binding: { zones: [], wave_paths: [], world_name: null },
};

const TEAM_COLORS = ['#4ecca3', '#e94560', '#60a0e0', '#e0a060', '#a080e0', '#e06080'];

const inputStyle: React.CSSProperties = {
  background: '#0f0f23', border: '1px solid #333', borderRadius: 4,
  padding: '4px 8px', color: '#ccc', fontSize: 12,
};

const btnStyle: React.CSSProperties = {
  padding: '4px 10px', background: '#1a2a4a', color: '#60a0e0',
  border: '1px solid #2a4a6a', borderRadius: 4, cursor: 'pointer', fontSize: 12,
};

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 12, border: '1px solid #1a2a4a', borderRadius: 6 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', padding: '8px 12px', background: '#0f1a30', border: 'none',
          color: '#c0c8d0', fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
          borderRadius: open ? '6px 6px 0 0' : 6,
        }}
      >
        {open ? '\u25BC' : '\u25B6'} {title}
      </button>
      {open && <div style={{ padding: 12, background: '#0d1525' }}>{children}</div>}
    </div>
  );
}

export function RulesEditor() {
  const [def, setDef] = useState<GameDefinition>(DEFAULT_DEF);
  const [savedGames, setSavedGames] = useState<string[]>([]);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState('');

  // Load saved game list
  useEffect(() => {
    gameDefStore.list().then(setSavedGames);
  }, []);

  const update = useCallback(<K extends keyof GameDefinition>(key: K, value: GameDefinition[K]) => {
    setDef(prev => ({ ...prev, [key]: value }));
  }, []);

  // Save
  const handleSave = useCallback(async () => {
    const name = def.name.trim() || 'Untitled';
    await gameDefStore.save(name, def as unknown as Record<string, unknown>);
    setCurrentName(name);
    setSaveStatus(`Saved "${name}"`);
    setSavedGames(await gameDefStore.list());
    setTimeout(() => setSaveStatus(''), 3000);
  }, [def]);

  // Load
  const handleLoad = useCallback(async (name: string) => {
    const record = await gameDefStore.load(name);
    if (record) {
      setDef(record.definition as unknown as GameDefinition);
      setCurrentName(name);
    }
  }, []);

  // Delete
  const handleDelete = useCallback(async (name: string) => {
    await gameDefStore.delete(name);
    setSavedGames(await gameDefStore.list());
    if (currentName === name) setCurrentName(null);
  }, [currentName]);

  // Team helpers
  const addTeam = useCallback(() => {
    const nextId = Math.max(0, ...def.teams.map(t => t.id)) + 1;
    const color = TEAM_COLORS[nextId % TEAM_COLORS.length];
    update('teams', [...def.teams, {
      id: nextId, name: `Team ${nextId}`, controller: { Cpu: { script_name: 'default_ai' } }, color,
    }]);
  }, [def.teams, update]);

  const removeTeam = useCallback((id: number) => {
    update('teams', def.teams.filter(t => t.id !== id));
  }, [def.teams, update]);

  // Stat helpers
  const addStat = useCallback(() => {
    const stats = [...def.stat_schema.stats, {
      key: `stat_${def.stat_schema.stats.length}`, display_name: 'New Stat',
      default_value: 0, min_value: 0, max_value: 100, visible: true, visible_to_enemies: false,
    }];
    update('stat_schema', { stats });
  }, [def.stat_schema, update]);

  const removeStat = useCallback((idx: number) => {
    const stats = def.stat_schema.stats.filter((_, i) => i !== idx);
    update('stat_schema', { stats });
  }, [def.stat_schema, update]);

  const updateStat = useCallback((idx: number, field: string, value: unknown) => {
    const stats = def.stat_schema.stats.map((s, i) => i === idx ? { ...s, [field]: value } : s);
    update('stat_schema', { stats });
  }, [def.stat_schema, update]);

  // Resource helpers
  const addResource = useCallback(() => {
    const resources = [...def.resource_schema.resources, {
      key: `res_${def.resource_schema.resources.length}`, display_name: 'New Resource',
      starting_amount: 0, max_amount: -1, map_object_id: null, icon_id: null,
    }];
    update('resource_schema', { resources });
  }, [def.resource_schema, update]);

  const removeResource = useCallback((idx: number) => {
    const resources = def.resource_schema.resources.filter((_, i) => i !== idx);
    update('resource_schema', { resources });
  }, [def.resource_schema, update]);

  const updateResource = useCallback((idx: number, field: string, value: unknown) => {
    const resources = def.resource_schema.resources.map((r, i) => i === idx ? { ...r, [field]: value } : r);
    update('resource_schema', { resources });
  }, [def.resource_schema, update]);

  // ── Asset discovery for template dropdowns ──────────────────────────
  const [availableChars, setAvailableChars] = useState<{ id: string; name: string }[]>([]);
  const [availableObjects, setAvailableObjects] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    async function loadAssets() {
      const storage = createStorage();
      // Discover characters (same pattern as CharacterEditor)
      try {
        const charFiles = await storage.list('characters');
        const charIds = [...new Set(
          charFiles.filter(f => f.includes('/') && f.endsWith('definition.json')).map(f => f.split('/')[1])
        )];
        const chars: { id: string; name: string }[] = [];
        for (const id of charIds) {
          try {
            const json = await storage.readText(`characters/${id}/definition.json`);
            const parsed = JSON.parse(json);
            chars.push({ id, name: parsed.name || id });
          } catch { chars.push({ id, name: id }); }
        }
        setAvailableChars(chars);
      } catch (err) {
        console.warn('[RulesEditor] Failed to load character assets:', err);
      }
      // Discover objects (same pattern as ObjectEditor)
      try {
        const objFiles = await storage.list('objects');
        const objIds = [...new Set(
          objFiles.filter(f => f.includes('/') && (f.endsWith('definition.json') || f.endsWith('properties.json'))).map(f => f.split('/')[1])
        )];
        const objs: { id: string; name: string }[] = [];
        for (const id of objIds) {
          try {
            const json = await storage.readText(`objects/${id}/definition.json`);
            const parsed = JSON.parse(json);
            objs.push({ id, name: parsed.name || id });
          } catch { objs.push({ id, name: id }); }
        }
        setAvailableObjects(objs);
      } catch (err) {
        console.warn('[RulesEditor] Failed to load object assets:', err);
      }
    }
    loadAssets();
  }, []);

  // ── Character template helpers ──────────────────────────────────────

  const addTemplate = useCallback(() => {
    const id = `template_${Date.now()}`;
    // Seed base_stats from the current stat schema defaults
    const baseStats: Record<string, number> = {};
    for (const stat of def.stat_schema.stats) {
      baseStats[stat.key] = stat.default_value;
    }
    update('character_templates', [...def.character_templates, {
      id, name: 'New Template', body_def_id: availableChars[0]?.id ?? '',
      base_stats: baseStats, weapon_def_id: null, throwable_def_id: null, tags: [],
    }]);
  }, [def.character_templates, def.stat_schema, availableChars, update]);

  const removeTemplate = useCallback((idx: number) => {
    update('character_templates', def.character_templates.filter((_, i) => i !== idx));
  }, [def.character_templates, update]);

  const updateTemplate = useCallback((idx: number, field: string, value: unknown) => {
    const templates = def.character_templates.map((t, i) => i === idx ? { ...t, [field]: value } : t);
    update('character_templates', templates);
  }, [def.character_templates, update]);

  const updateTemplateStat = useCallback((tmplIdx: number, statKey: string, value: number) => {
    const templates = def.character_templates.map((t, i) => {
      if (i !== tmplIdx) return t;
      return { ...t, base_stats: { ...t.base_stats, [statKey]: value } };
    });
    update('character_templates', templates);
  }, [def.character_templates, update]);

  // ── WASM validator ──────────────────────────────────────────────────
  const validatorRef = useRef<{ validate_game_json: (json: string) => string } | null>(null);
  const [validatorReady, setValidatorReady] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResultDto | null>(null);

  useEffect(() => {
    async function loadValidator() {
      try {
        const mod = await import('../../wasm-validator/wasm_validator');
        await mod.default();
        mod.init_validator();
        validatorRef.current = mod;
        setValidatorReady(true);
      } catch (err) {
        console.warn('[RulesEditor] Failed to load wasm-validator:', err);
      }
    }
    loadValidator();
  }, []);

  const handleValidate = useCallback(() => {
    if (!validatorRef.current) return;
    const json = JSON.stringify(def);
    const resultJson = validatorRef.current.validate_game_json(json);
    setValidationResult(JSON.parse(resultJson));
  }, [def]);

  // ── World binding helpers ───────────────────────────────────────────
  const [savedWorlds, setSavedWorlds] = useState<string[]>([]);

  useEffect(() => {
    worldStore.list().then(setSavedWorlds).catch(() => {});
  }, []);

  const updateWorldBinding = useCallback(<K extends keyof WorldBindingDef>(field: K, value: WorldBindingDef[K]) => {
    update('world_binding', { ...def.world_binding, [field]: value });
  }, [def.world_binding, update]);

  const addZone = useCallback(() => {
    const zone: ZoneDef = {
      name: `zone_${def.world_binding.zones.length}`,
      x: 0, y: 0, width: 5, height: 5,
      zone_type: 'SpawnPoint',
      team_id: def.teams[0]?.id ?? null,
    };
    updateWorldBinding('zones', [...def.world_binding.zones, zone]);
  }, [def.world_binding.zones, def.teams, updateWorldBinding]);

  const removeZone = useCallback((idx: number) => {
    updateWorldBinding('zones', def.world_binding.zones.filter((_, i) => i !== idx));
  }, [def.world_binding.zones, updateWorldBinding]);

  const updateZone = useCallback((idx: number, field: string, value: unknown) => {
    const zones = def.world_binding.zones.map((z, i) => i === idx ? { ...z, [field]: value } : z);
    updateWorldBinding('zones', zones);
  }, [def.world_binding.zones, updateWorldBinding]);

  const addWavePath = useCallback(() => {
    const path: WavePathDef = {
      name: `path_${def.world_binding.wave_paths.length}`,
      waypoints: [[0, 0], [10, 0]],
    };
    updateWorldBinding('wave_paths', [...def.world_binding.wave_paths, path]);
  }, [def.world_binding.wave_paths, updateWorldBinding]);

  const removeWavePath = useCallback((idx: number) => {
    updateWorldBinding('wave_paths', def.world_binding.wave_paths.filter((_, i) => i !== idx));
  }, [def.world_binding.wave_paths, updateWorldBinding]);

  const updateWavePath = useCallback((idx: number, field: string, value: unknown) => {
    const paths = def.world_binding.wave_paths.map((p, i) => i === idx ? { ...p, [field]: value } : p);
    updateWorldBinding('wave_paths', paths);
  }, [def.world_binding.wave_paths, updateWorldBinding]);

  const addWaypoint = useCallback((pathIdx: number) => {
    const path = def.world_binding.wave_paths[pathIdx];
    if (!path) return;
    const last = path.waypoints[path.waypoints.length - 1] ?? [0, 0];
    const newWps: [number, number][] = [...path.waypoints, [last[0] + 5, last[1]]];
    updateWavePath(pathIdx, 'waypoints', newWps);
  }, [def.world_binding.wave_paths, updateWavePath]);

  const removeWaypoint = useCallback((pathIdx: number, wpIdx: number) => {
    const path = def.world_binding.wave_paths[pathIdx];
    if (!path) return;
    updateWavePath(pathIdx, 'waypoints', path.waypoints.filter((_, i) => i !== wpIdx));
  }, [def.world_binding.wave_paths, updateWavePath]);

  const updateWaypoint = useCallback((pathIdx: number, wpIdx: number, axis: 0 | 1, value: number) => {
    const path = def.world_binding.wave_paths[pathIdx];
    if (!path) return;
    const wps = path.waypoints.map((wp, i) => {
      if (i !== wpIdx) return wp;
      const copy: [number, number] = [...wp];
      copy[axis] = value;
      return copy;
    });
    updateWavePath(pathIdx, 'waypoints', wps);
  }, [def.world_binding.wave_paths, updateWavePath]);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 40px)', background: '#0a0e1a', color: '#c0c8d0' }}>
      {/* Sidebar — saved games */}
      <div style={{ width: 200, borderRight: '1px solid #1a2a4a', padding: 8, overflowY: 'auto', fontSize: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: '#e94560' }}>Saved Games</div>
        {savedGames.map(name => (
          <div key={name} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
            <button onClick={() => handleLoad(name)} style={{
              ...btnStyle, flex: 1, textAlign: 'left', fontSize: 11,
              background: currentName === name ? '#1a2a4a' : 'transparent',
              border: currentName === name ? '1px solid #60a0e0' : '1px solid transparent',
            }}>{name}</button>
            <button onClick={() => handleDelete(name)} style={{ ...btnStyle, color: '#e94560', padding: '2px 6px', fontSize: 10 }}>X</button>
          </div>
        ))}
        {savedGames.length === 0 && <div style={{ color: '#556677' }}>No saved games yet</div>}
      </div>

      {/* Main editor */}
      <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h2 style={{ margin: 0, color: '#e94560', fontSize: 18 }}>Game Rules Editor</h2>
          <button onClick={handleSave} style={{ ...btnStyle, background: '#1a3a2a', color: '#8ac060', border: '1px solid #3a5a2a' }}>
            Save
          </button>
          {saveStatus && <span style={{ color: '#8ac060', fontSize: 11 }}>{saveStatus}</span>}
        </div>

        {/* 1. Basics */}
        <Section title="Game Basics">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, fontSize: 12 }}>Name:</span>
              <input value={def.name} onChange={e => update('name', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, fontSize: 12 }}>Description:</span>
              <input value={def.description} onChange={e => update('description', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, fontSize: 12 }}>Mode:</span>
              <select value={def.mode} onChange={e => update('mode', e.target.value as GameMode)} style={inputStyle}>
                <option value="RealTime">Real-Time (Bloons TD, StarCraft)</option>
                <option value="Tactical">Tactical (KOTOR, XCOM)</option>
                <option value="TurnBased">Turn-Based (Fire Emblem, Civ)</option>
              </select>
            </label>
          </div>
        </Section>

        {/* 2. Teams */}
        <Section title={`Teams (${def.teams.length})`}>
          {def.teams.map((team, idx) => (
            <div key={team.id} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <input type="color" value={team.color} onChange={e => {
                const teams = [...def.teams];
                teams[idx] = { ...team, color: e.target.value };
                update('teams', teams);
              }} style={{ width: 28, height: 28, border: 'none', cursor: 'pointer' }} />
              <input value={team.name} onChange={e => {
                const teams = [...def.teams];
                teams[idx] = { ...team, name: e.target.value };
                update('teams', teams);
              }} style={{ ...inputStyle, width: 120 }} />
              <select value={team.controller === 'Human' ? 'human' : 'cpu'} onChange={e => {
                const teams = [...def.teams];
                teams[idx] = { ...team, controller: e.target.value === 'human' ? 'Human' : { Cpu: { script_name: 'default_ai' } } };
                update('teams', teams);
              }} style={inputStyle}>
                <option value="human">Human</option>
                <option value="cpu">CPU</option>
              </select>
              {typeof team.controller === 'object' && 'Cpu' in team.controller && (
                <input
                  value={(team.controller as { Cpu: { script_name: string } }).Cpu.script_name}
                  onChange={e => {
                    const teams = [...def.teams];
                    teams[idx] = { ...team, controller: { Cpu: { script_name: e.target.value } } };
                    update('teams', teams);
                  }}
                  placeholder="AI script name"
                  style={{ ...inputStyle, width: 120 }}
                />
              )}
              <button onClick={() => removeTeam(team.id)} style={{ ...btnStyle, color: '#e94560', padding: '2px 8px' }}>Remove</button>
            </div>
          ))}
          <button onClick={addTeam} style={btnStyle}>+ Add Team</button>
        </Section>

        {/* 3. Stats */}
        <Section title={`Character Stats (${def.stat_schema.stats.length})`}>
          {def.stat_schema.stats.map((stat, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', fontSize: 11 }}>
              <input value={stat.key} onChange={e => updateStat(idx, 'key', e.target.value)} style={{ ...inputStyle, width: 80 }} placeholder="key" />
              <input value={stat.display_name} onChange={e => updateStat(idx, 'display_name', e.target.value)} style={{ ...inputStyle, width: 100 }} placeholder="Display Name" />
              <span style={{ color: '#556677' }}>Default:</span>
              <input type="number" value={stat.default_value} onChange={e => updateStat(idx, 'default_value', parseFloat(e.target.value) || 0)} style={{ ...inputStyle, width: 50 }} />
              <span style={{ color: '#556677' }}>Range:</span>
              <input type="number" value={stat.min_value} onChange={e => updateStat(idx, 'min_value', parseFloat(e.target.value) || 0)} style={{ ...inputStyle, width: 40 }} />
              <span style={{ color: '#556677' }}>-</span>
              <input type="number" value={stat.max_value} onChange={e => updateStat(idx, 'max_value', parseFloat(e.target.value) || 100)} style={{ ...inputStyle, width: 50 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                <input type="checkbox" checked={stat.visible} onChange={e => updateStat(idx, 'visible', e.target.checked)} />
                Vis
              </label>
              <button onClick={() => removeStat(idx)} style={{ ...btnStyle, color: '#e94560', padding: '1px 6px', fontSize: 10 }}>X</button>
            </div>
          ))}
          <button onClick={addStat} style={btnStyle}>+ Add Stat</button>
        </Section>

        {/* 4. Resources */}
        <Section title={`Resources (${def.resource_schema.resources.length})`} defaultOpen={false}>
          {def.resource_schema.resources.map((res, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', fontSize: 11 }}>
              <input value={res.key} onChange={e => updateResource(idx, 'key', e.target.value)} style={{ ...inputStyle, width: 80 }} placeholder="key" />
              <input value={res.display_name} onChange={e => updateResource(idx, 'display_name', e.target.value)} style={{ ...inputStyle, width: 100 }} placeholder="Display Name" />
              <span style={{ color: '#556677' }}>Start:</span>
              <input type="number" value={res.starting_amount} onChange={e => updateResource(idx, 'starting_amount', parseFloat(e.target.value) || 0)} style={{ ...inputStyle, width: 60 }} />
              <button onClick={() => removeResource(idx)} style={{ ...btnStyle, color: '#e94560', padding: '1px 6px', fontSize: 10 }}>X</button>
            </div>
          ))}
          <button onClick={addResource} style={btnStyle}>+ Add Resource</button>
        </Section>

        {/* 5. Character Templates */}
        <Section title={`Character Templates (${def.character_templates.length})`} defaultOpen={false}>
          {availableChars.length === 0 && (
            <div style={{ color: '#886644', fontSize: 11, marginBottom: 8 }}>
              No character assets found. Create characters in the Character Editor first.
            </div>
          )}
          {def.character_templates.map((tmpl, idx) => (
            <div key={tmpl.id} style={{ marginBottom: 10, padding: 8, background: '#0a1020', borderRadius: 4, border: '1px solid #1a2a4a' }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', fontSize: 11 }}>
                <input value={tmpl.id} onChange={e => updateTemplate(idx, 'id', e.target.value)} style={{ ...inputStyle, width: 100 }} placeholder="template_id" />
                <input value={tmpl.name} onChange={e => updateTemplate(idx, 'name', e.target.value)} style={{ ...inputStyle, width: 120 }} placeholder="Display Name" />
                <span style={{ color: '#556677' }}>Body:</span>
                <select value={tmpl.body_def_id} onChange={e => updateTemplate(idx, 'body_def_id', e.target.value)} style={inputStyle}>
                  <option value="">(none)</option>
                  {availableChars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button onClick={() => removeTemplate(idx)} style={{ ...btnStyle, color: '#e94560', padding: '2px 8px', fontSize: 10 }}>Remove</button>
              </div>
              {/* Equipment */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', fontSize: 11 }}>
                <span style={{ color: '#556677', width: 60 }}>Weapon:</span>
                <select
                  value={tmpl.weapon_def_id ?? ''}
                  onChange={e => updateTemplate(idx, 'weapon_def_id', e.target.value || null)}
                  style={inputStyle}
                >
                  <option value="">(none)</option>
                  {availableObjects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <span style={{ color: '#556677', width: 60 }}>Throwable:</span>
                <select
                  value={tmpl.throwable_def_id ?? ''}
                  onChange={e => updateTemplate(idx, 'throwable_def_id', e.target.value || null)}
                  style={inputStyle}
                >
                  <option value="">(none)</option>
                  {availableObjects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              {/* Base stats from schema */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4, fontSize: 11 }}>
                {def.stat_schema.stats.map(stat => (
                  <label key={stat.key} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{ color: '#556677' }}>{stat.key}:</span>
                    <input
                      type="number"
                      value={tmpl.base_stats[stat.key] ?? stat.default_value}
                      onChange={e => updateTemplateStat(idx, stat.key, parseFloat(e.target.value) || 0)}
                      style={{ ...inputStyle, width: 50 }}
                    />
                  </label>
                ))}
              </div>
              {/* Tags */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
                <span style={{ color: '#556677' }}>Tags:</span>
                <input
                  value={tmpl.tags.join(', ')}
                  onChange={e => updateTemplate(idx, 'tags', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder="infantry, ranged, boss (comma-separated)"
                />
              </div>
            </div>
          ))}
          <button onClick={addTemplate} style={btnStyle}>+ Add Template</button>
        </Section>

        {/* 6. Win Conditions */}
        <Section title={`Win Conditions (${def.win_conditions.length})`} defaultOpen={false}>
          {def.win_conditions.map((wc, idx) => {
            const wcType = getWcType(wc);
            return (
              <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', fontSize: 11 }}>
                <select value={wcType} onChange={e => {
                  const wcs = [...def.win_conditions];
                  wcs[idx] = makeWinCondition(e.target.value);
                  update('win_conditions', wcs);
                }} style={inputStyle}>
                  <option value="Elimination">Elimination (last team standing)</option>
                  <option value="Survival">Survival (survive N waves/turns)</option>
                  <option value="ResourceThreshold">Resource Threshold</option>
                  <option value="Custom">Custom (script-defined)</option>
                </select>
                {wcType === 'Survival' && typeof wc === 'object' && 'Survival' in wc && (
                  <>
                    <span style={{ color: '#556677' }}>Waves/Turns:</span>
                    <input type="number" value={wc.Survival.turns_or_waves} onChange={e => {
                      const wcs = [...def.win_conditions];
                      wcs[idx] = { Survival: { turns_or_waves: parseInt(e.target.value) || 10 } };
                      update('win_conditions', wcs);
                    }} style={{ ...inputStyle, width: 50 }} />
                  </>
                )}
                {wcType === 'ResourceThreshold' && typeof wc === 'object' && 'ResourceThreshold' in wc && (
                  <>
                    <span style={{ color: '#556677' }}>Resource:</span>
                    <input value={wc.ResourceThreshold.resource_key} onChange={e => {
                      const wcs = [...def.win_conditions];
                      wcs[idx] = { ResourceThreshold: { ...wc.ResourceThreshold, resource_key: e.target.value } };
                      update('win_conditions', wcs);
                    }} style={{ ...inputStyle, width: 80 }} placeholder="key" />
                    <span style={{ color: '#556677' }}>Amount:</span>
                    <input type="number" value={wc.ResourceThreshold.amount} onChange={e => {
                      const wcs = [...def.win_conditions];
                      wcs[idx] = { ResourceThreshold: { ...wc.ResourceThreshold, amount: parseFloat(e.target.value) || 100 } };
                      update('win_conditions', wcs);
                    }} style={{ ...inputStyle, width: 60 }} />
                  </>
                )}
                {wcType === 'Custom' && typeof wc === 'object' && 'Custom' in wc && (
                  <>
                    <span style={{ color: '#556677' }}>Condition:</span>
                    <input value={wc.Custom.condition_name} onChange={e => {
                      const wcs = [...def.win_conditions];
                      wcs[idx] = { Custom: { condition_name: e.target.value } };
                      update('win_conditions', wcs);
                    }} style={{ ...inputStyle, width: 120 }} placeholder="condition name" />
                  </>
                )}
                <button onClick={() => update('win_conditions', def.win_conditions.filter((_, i) => i !== idx))} style={{ ...btnStyle, color: '#e94560', padding: '1px 6px', fontSize: 10 }}>X</button>
              </div>
            );
          })}
          <button onClick={() => update('win_conditions', [...def.win_conditions, 'Elimination' as WinCondition])} style={btnStyle}>+ Add Condition</button>
        </Section>

        {/* 7. Scripts */}
        <Section title="Scripts" defaultOpen={false}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 100, fontSize: 12 }}>Rules Script:</span>
              <input value={def.rules_script} onChange={e => update('rules_script', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 100, fontSize: 12 }}>World Gen:</span>
              <input value={def.world_gen_script ?? ''} onChange={e => update('world_gen_script', e.target.value || null)} style={{ ...inputStyle, flex: 1 }} placeholder="(optional)" />
            </label>
          </div>
        </Section>

        {/* 8. World Binding */}
        <Section title={`World Binding (${def.world_binding.zones.length} zones, ${def.world_binding.wave_paths.length} paths)`} defaultOpen={false}>
          {/* Target world */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: '#556677', width: 80 }}>World:</span>
            <select
              value={def.world_binding.world_name ?? ''}
              onChange={e => updateWorldBinding('world_name', e.target.value || null)}
              style={inputStyle}
            >
              <option value="">(none — create from world gen script)</option>
              {savedWorlds.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>

          {/* Zones */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#60a0e0', marginBottom: 6 }}>Zones</div>
            {def.world_binding.zones.map((zone, idx) => {
              const ztName = getZoneTypeName(zone.zone_type);
              return (
                <div key={idx} style={{ marginBottom: 8, padding: 8, background: '#0a1020', borderRadius: 4, border: '1px solid #1a2a4a' }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', fontSize: 11 }}>
                    <input value={zone.name} onChange={e => updateZone(idx, 'name', e.target.value)} style={{ ...inputStyle, width: 100 }} placeholder="name" />
                    <select value={ztName} onChange={e => updateZone(idx, 'zone_type', makeZoneType(e.target.value))} style={inputStyle}>
                      {Object.entries(ZONE_TYPE_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>{label}</option>
                      ))}
                    </select>
                    <button onClick={() => removeZone(idx)} style={{ ...btnStyle, color: '#e94560', padding: '2px 8px', fontSize: 10 }}>Remove</button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
                    <span style={{ color: '#556677' }}>Team:</span>
                    <select
                      value={zone.team_id ?? ''}
                      onChange={e => updateZone(idx, 'team_id', e.target.value === '' ? null : parseInt(e.target.value))}
                      style={inputStyle}
                    >
                      <option value="">(none)</option>
                      {def.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <span style={{ color: '#556677' }}>x:</span>
                    <input type="number" value={zone.x} onChange={e => updateZone(idx, 'x', parseInt(e.target.value) || 0)} style={{ ...inputStyle, width: 50 }} />
                    <span style={{ color: '#556677' }}>y:</span>
                    <input type="number" value={zone.y} onChange={e => updateZone(idx, 'y', parseInt(e.target.value) || 0)} style={{ ...inputStyle, width: 50 }} />
                    <span style={{ color: '#556677' }}>w:</span>
                    <input type="number" value={zone.width} onChange={e => updateZone(idx, 'width', parseInt(e.target.value) || 1)} style={{ ...inputStyle, width: 40 }} />
                    <span style={{ color: '#556677' }}>h:</span>
                    <input type="number" value={zone.height} onChange={e => updateZone(idx, 'height', parseInt(e.target.value) || 1)} style={{ ...inputStyle, width: 40 }} />
                  </div>
                  {ztName === 'ResourceProducer' && (() => {
                    const rp = typeof zone.zone_type === 'object' && 'ResourceProducer' in zone.zone_type ? zone.zone_type.ResourceProducer : null;
                    if (!rp) return null;
                    return (
                      <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center', fontSize: 11 }}>
                        <span style={{ color: '#556677' }}>Resource:</span>
                        <input
                          value={rp.resource_key}
                          onChange={e => updateZone(idx, 'zone_type', { ResourceProducer: { ...rp, resource_key: e.target.value } })}
                          style={{ ...inputStyle, width: 80 }} placeholder="key"
                        />
                        <span style={{ color: '#556677' }}>Rate:</span>
                        <input
                          type="number"
                          value={rp.rate}
                          onChange={e => updateZone(idx, 'zone_type', { ResourceProducer: { ...rp, rate: parseFloat(e.target.value) || 1 } })}
                          style={{ ...inputStyle, width: 50 }}
                        />
                      </div>
                    );
                  })()}
                </div>
              );
            })}
            <button onClick={addZone} style={btnStyle}>+ Add Zone</button>
          </div>

          {/* Wave Paths */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#60a0e0', marginBottom: 6 }}>Wave Paths</div>
            <div style={{ color: '#556677', fontSize: 11, marginBottom: 6 }}>
              Ordered waypoints for enemy wave lanes (tower defense). Only needed for Survival win condition.
            </div>
            {def.world_binding.wave_paths.map((path, pIdx) => (
              <div key={pIdx} style={{ marginBottom: 8, padding: 8, background: '#0a1020', borderRadius: 4, border: '1px solid #1a2a4a' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', fontSize: 11 }}>
                  <input value={path.name} onChange={e => updateWavePath(pIdx, 'name', e.target.value)} style={{ ...inputStyle, width: 120 }} placeholder="path name" />
                  <span style={{ color: '#556677' }}>{path.waypoints.length} waypoints</span>
                  <button onClick={() => addWaypoint(pIdx)} style={{ ...btnStyle, fontSize: 10, padding: '2px 6px' }}>+ Point</button>
                  <button onClick={() => removeWavePath(pIdx)} style={{ ...btnStyle, color: '#e94560', padding: '2px 8px', fontSize: 10 }}>Remove Path</button>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {path.waypoints.map((wp, wIdx) => (
                    <div key={wIdx} style={{ display: 'flex', gap: 2, alignItems: 'center', fontSize: 10, background: '#0f1a30', padding: '2px 4px', borderRadius: 3 }}>
                      <span style={{ color: '#556677' }}>{wIdx}:</span>
                      <input type="number" value={wp[0]} onChange={e => updateWaypoint(pIdx, wIdx, 0, parseInt(e.target.value) || 0)} style={{ ...inputStyle, width: 40, fontSize: 10, padding: '2px 4px' }} />
                      <input type="number" value={wp[1]} onChange={e => updateWaypoint(pIdx, wIdx, 1, parseInt(e.target.value) || 0)} style={{ ...inputStyle, width: 40, fontSize: 10, padding: '2px 4px' }} />
                      <button onClick={() => removeWaypoint(pIdx, wIdx)} style={{ ...btnStyle, color: '#e94560', padding: '0 4px', fontSize: 9 }}>x</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={addWavePath} style={btnStyle}>+ Add Wave Path</button>
          </div>
        </Section>

        {/* 9. Validation */}
        <Section title="Validation" defaultOpen={false}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <button
              onClick={handleValidate}
              disabled={!validatorReady}
              style={{
                ...btnStyle,
                background: validatorReady ? '#1a3a2a' : '#222',
                color: validatorReady ? '#8ac060' : '#555',
                border: `1px solid ${validatorReady ? '#3a5a2a' : '#333'}`,
              }}
            >
              {validatorReady ? 'Validate' : 'Loading validator...'}
            </button>
            {validationResult && (
              <span style={{
                fontSize: 12, fontWeight: 600,
                color: validationResult.playable ? '#8ac060' : '#e94560',
              }}>
                {validationResult.playable ? 'PLAYABLE' : 'NOT PLAYABLE'}
              </span>
            )}
          </div>
          {validationResult && validationResult.issues.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {validationResult.issues.map((issue, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11 }}>
                  <span style={{
                    padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                    background: issue.severity === 'error' ? '#3a1020' : '#3a2a10',
                    color: issue.severity === 'error' ? '#e94560' : '#e0a060',
                    border: `1px solid ${issue.severity === 'error' ? '#5a2030' : '#5a4a20'}`,
                    flexShrink: 0,
                  }}>
                    {issue.severity === 'error' ? 'ERROR' : 'WARN'}
                  </span>
                  <span style={{ color: '#c0c8d0' }}>{issue.message}</span>
                </div>
              ))}
            </div>
          )}
          {validationResult && validationResult.issues.length === 0 && (
            <div style={{ color: '#8ac060', fontSize: 11 }}>No issues found.</div>
          )}
        </Section>

        {/* 9. JSON Preview */}
        <Section title="Definition Preview (JSON)" defaultOpen={false}>
          <pre style={{ fontSize: 10, color: '#556677', maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(def, null, 2)}
          </pre>
        </Section>
      </div>
    </div>
  );
}

export default RulesEditor;
