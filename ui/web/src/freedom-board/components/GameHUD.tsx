/**
 * GameHUD — Play-mode heads-up display.
 *
 * Shows game session state during play: phase, mode, active team,
 * per-team resources, unit counts, and game outcome.
 *
 * Renders as an overlay positioned at the top-center of the canvas area.
 * Visible only when isPlaying is true and hudState is non-null.
 *
 * Data source: WASM `take_game_hud_state()` via worker polling.
 * Change-gated — only updates on discrete state changes (phase, resource,
 * spawn/kill, start/stop). No per-frame JSON churn.
 *
 * Also displays start-failure diagnostics when startErrors is non-null.
 */

import React from 'react';

// ── DTO shapes (matches WASM serialization in lib.rs) ──────────────

interface HudTeam {
  id: number;
  name: string;
  resources: Record<string, number>;
  unitCount: number;
}

interface HudState {
  phase: string;
  mode: string;
  turnNumber: number;
  activeTeam: number | null;
  teams: HudTeam[];
  ended: boolean;
  winner: number | null;
  paused: boolean;
}

interface StartError {
  kind: string;
  message: string;
  scope?: string;
  scriptName?: string;
}

interface GameHUDProps {
  isPlaying: boolean;
  hudState: Record<string, unknown> | null;
  startErrors: Array<Record<string, unknown>> | null;
  onTogglePause?: () => void;
}

// ── Styles ─────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 20,
  pointerEvents: 'none',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
};

const hudBarStyle: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.75)',
  color: '#eee',
  borderRadius: 6,
  padding: '6px 16px',
  fontSize: 13,
  fontFamily: 'monospace',
  display: 'flex',
  gap: 16,
  alignItems: 'center',
  pointerEvents: 'auto',
};

const teamStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  fontSize: 12,
};

const phaseStyle: React.CSSProperties = {
  fontWeight: 'bold',
  color: '#4fc3f7',
  fontSize: 14,
};

const endedStyle: React.CSSProperties = {
  fontWeight: 'bold',
  color: '#ffd54f',
  fontSize: 14,
};

const errorContainerStyle: React.CSSProperties = {
  background: 'rgba(180, 30, 30, 0.9)',
  color: '#fff',
  borderRadius: 6,
  padding: '8px 14px',
  fontSize: 12,
  fontFamily: 'monospace',
  maxWidth: 500,
  pointerEvents: 'auto',
};

// ── Component ──────────────────────────────────────────────────────

export function GameHUD({ isPlaying, hudState, startErrors, onTogglePause }: GameHUDProps) {
  // Show error panel even when not playing (start_failed = not playing)
  const hasErrors = startErrors && startErrors.length > 0;

  if (!isPlaying && !hasErrors) return null;

  const hud = hudState as HudState | null;
  const errors = startErrors as StartError[] | null;

  return (
    <div style={containerStyle}>
      {/* HUD bar — visible during play */}
      {isPlaying && hud && (
        <div style={hudBarStyle}>
          {/* Pause/Resume button */}
          {!hud.ended && onTogglePause && (
            <button
              onClick={onTogglePause}
              style={{
                padding: '2px 10px',
                background: hud.paused ? '#4a3a00' : '#1a2a4a',
                color: hud.paused ? '#ffd54f' : '#8899aa',
                border: `1px solid ${hud.paused ? '#6a5a20' : '#2a3a5a'}`,
                borderRadius: 3,
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 600,
                pointerEvents: 'auto',
              }}
            >
              {hud.paused ? 'Resume' : 'Pause'}
            </button>
          )}

          {/* Phase / Paused indicator */}
          {hud.ended ? (
            <span style={endedStyle}>
              GAME OVER{hud.winner != null ? ` — Team ${hud.winner} wins` : ''}
            </span>
          ) : hud.paused ? (
            <span style={{ fontWeight: 'bold', color: '#ffd54f', fontSize: 14 }}>
              PAUSED
            </span>
          ) : (
            <span style={phaseStyle}>{formatPhase(hud.phase)}</span>
          )}

          {/* Mode indicator */}
          <span style={{ color: '#aaa', fontSize: 11 }}>{hud.mode}</span>

          {/* Turn (if turn-based) */}
          {hud.mode === 'TurnBased' && hud.turnNumber > 0 && (
            <span>Turn {hud.turnNumber}</span>
          )}

          {/* Active team */}
          {hud.activeTeam != null && (
            <span style={{ color: '#81c784' }}>
              {hud.teams.find(t => t.id === hud.activeTeam)?.name ?? `Team ${hud.activeTeam}`}
            </span>
          )}

          {/* Team summaries */}
          {hud.teams.map(team => (
            <div key={team.id} style={teamStyle}>
              <span style={{ color: '#ddd' }}>
                {team.name}
              </span>
              <span style={{ color: '#aaa' }}>
                {team.unitCount}u
              </span>
              {Object.entries(team.resources).map(([key, val]) => (
                <span key={key} style={{ color: '#ffcc80' }}>
                  {key}: {Math.floor(val as number)}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Start failure errors */}
      {hasErrors && (
        <div style={errorContainerStyle}>
          <div style={{ fontWeight: 'bold', marginBottom: 4, color: '#ff8a80' }}>
            Start Failed
          </div>
          {errors!.map((err, i) => (
            <div key={i} style={{ marginBottom: 2 }}>
              <span style={{ color: '#ffab91' }}>[{err.kind}]</span>{' '}
              {err.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Format internal phase names for display. */
function formatPhase(phase: string): string {
  // Phase strings come as Rust Debug format, e.g., "Exploration", "Ended { winner: Some(TeamId(0)) }"
  if (phase.startsWith('Ended')) return 'Game Over';
  return phase;
}
