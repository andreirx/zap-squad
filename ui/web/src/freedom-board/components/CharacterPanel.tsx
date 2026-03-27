/**
 * CharacterPanel — displays info and script assignment for the selected character.
 *
 * Shown at the bottom of the Freedom Board when a character is selected.
 * Reads character info from WASM (via onSelectedCharacter callback).
 * Sends script assignment to WASM (via sendEvent).
 *
 * Responsibilities:
 * - display selected character properties (body, position, health, current script)
 * - list character_ai scripts from IDB for assignment
 * - send assign_character_script message to WASM worker
 *
 * Does NOT own persistence or script editing — those belong to ScriptPanel.
 */

import { useState, useEffect, useCallback } from 'react';
import { scriptStore } from '../../lib/idb';
import type { ScriptScope } from '../../lib/idb';

// ── Types ─────────────────────────────────────────────────────────────

/** Character info as sent from WASM via take_selected_character_info(). */
export interface SelectedCharacterInfo {
  actorId: number;
  bodyDefId: string;
  scriptName: string | null;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
}

interface CharacterPanelProps {
  /** JSON from WASM, or null when no character is selected. */
  characterJson: string | null;
  /** Send a message to the WASM worker. */
  sendEvent: (msg: Record<string, unknown>) => void;
  /** Panel is read-only during play mode. */
  disabled?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────

export function CharacterPanel({ characterJson, sendEvent, disabled = false }: CharacterPanelProps) {
  const [info, setInfo] = useState<SelectedCharacterInfo | null>(null);
  const [aiScripts, setAiScripts] = useState<string[]>([]);
  const [selectedScript, setSelectedScript] = useState<string>('');

  // Parse character JSON from WASM
  useEffect(() => {
    if (!characterJson) {
      setInfo(null);
      return;
    }
    try {
      const parsed = JSON.parse(characterJson) as SelectedCharacterInfo;
      setInfo(parsed);
      setSelectedScript(parsed.scriptName ?? '');
    } catch {
      setInfo(null);
    }
  }, [characterJson]);

  // Load character_ai scripts from IDB.
  // Re-fetches whenever the selected character changes, which also catches
  // scripts created/deleted in ScriptPanel while a character is selected.
  useEffect(() => {
    if (!characterJson) return;
    scriptStore.getAll()
      .then(all => {
        const names = all
          .filter(({ value }) => (value as { scope: ScriptScope }).scope === 'character_ai')
          .map(({ key }) => key)
          .sort();
        setAiScripts(names);
      })
      .catch(err => {
        console.error('[character-panel] failed to load scripts:', err);
      });
  }, [characterJson]);

  const handleAssign = useCallback(() => {
    if (!info) return;
    sendEvent({
      type: 'assign_character_script',
      actorId: info.actorId,
      scriptName: selectedScript, // empty string = clear assignment
    });
  }, [info, selectedScript, sendEvent]);

  if (!info) return null;

  const hasChange = (info.scriptName ?? '') !== selectedScript;

  return (
    <div style={{
      padding: '6px 12px',
      background: '#16213e',
      borderTop: '1px solid #1a2a4a',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 11,
      flexShrink: 0,
    }}>
      {/* Character identity */}
      <span style={{ color: '#8899aa', fontWeight: 600 }}>
        {info.bodyDefId}
      </span>
      <span style={{ color: '#445566' }}>
        ({info.x.toFixed(1)}, {info.y.toFixed(1)})
      </span>
      <span style={{ color: '#556677' }}>
        HP {info.health}/{info.maxHealth}
      </span>

      {/* Separator */}
      <div style={{ width: 1, height: 16, background: '#1a2a4a' }} />

      {/* Script assignment */}
      <span style={{ color: '#60a0e0', fontSize: 10 }}>AI Script:</span>
      <select
        value={selectedScript}
        onChange={e => setSelectedScript(e.target.value)}
        disabled={disabled}
        style={{
          background: '#0f0f23',
          border: '1px solid #333',
          borderRadius: 3,
          padding: '2px 6px',
          color: '#ccc',
          fontSize: 11,
          minWidth: 120,
        }}
      >
        <option value="">(none)</option>
        {aiScripts.map(name => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      <button
        onClick={handleAssign}
        disabled={disabled || !hasChange}
        style={{
          padding: '2px 8px',
          background: hasChange && !disabled ? '#1a3a2a' : '#1a1a2a',
          color: hasChange && !disabled ? '#4ecca3' : '#445566',
          border: `1px solid ${hasChange && !disabled ? '#2a5a3a' : '#222'}`,
          borderRadius: 3,
          cursor: hasChange && !disabled ? 'pointer' : 'default',
          fontSize: 10,
        }}
        title="Assign selected script to this character"
      >
        Assign
      </button>
      {info.scriptName && (
        <span style={{ color: '#4ecca3', fontSize: 9, marginLeft: 4 }}>
          current: {info.scriptName}
        </span>
      )}
    </div>
  );
}
