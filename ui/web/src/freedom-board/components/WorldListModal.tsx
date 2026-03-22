import { useState, useEffect, useCallback } from 'react';
import { worldStore } from '../../lib/idb';

interface WorldEntry {
  name: string;
  tileCount: number;
  characterCount: number;
  updatedAt: number;
}

interface WorldListModalProps {
  onClose: () => void;
  onLoad: (name: string) => void;
  /** Triggers a world export from WASM, then saves with the given name. */
  onSaveAs: (name: string) => void;
}

/**
 * Modal overlay for managing saved worlds.
 *
 * Lists all worlds in IDB with tile/character counts and timestamps.
 * Actions: Load, Save As, Rename, Delete.
 * The "autosave" entry is always shown first and cannot be deleted or renamed.
 */
export function WorldListModal({ onClose, onLoad, onSaveAs }: WorldListModalProps) {
  const [worlds, setWorlds] = useState<WorldEntry[]>([]);
  const [saveAsName, setSaveAsName] = useState('');
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const refresh = useCallback(async () => {
    const all = await worldStore.getAll();
    const entries: WorldEntry[] = all.map(({ key, value }) => ({
      name: key,
      tileCount: value.tiles?.length ?? 0,
      characterCount: value.characters?.length ?? 0,
      updatedAt: value.updatedAt ?? 0,
    }));
    // Sort: autosave first, then by updatedAt descending
    entries.sort((a, b) => {
      if (a.name === 'autosave') return -1;
      if (b.name === 'autosave') return 1;
      return b.updatedAt - a.updatedAt;
    });
    setWorlds(entries);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = useCallback(async (name: string) => {
    if (name === 'autosave') return;
    await worldStore.delete(name);
    refresh();
  }, [refresh]);

  const handleRename = useCallback(async (oldName: string) => {
    if (!renameValue.trim() || renameValue === oldName) {
      setRenamingKey(null);
      return;
    }
    await worldStore.rename(oldName, renameValue.trim());
    setRenamingKey(null);
    refresh();
  }, [renameValue, refresh]);

  const handleSaveAs = useCallback(() => {
    const name = saveAsName.trim();
    if (!name) return;
    onSaveAs(name);
    setSaveAsName('');
    // Refresh after a short delay to let the save complete
    setTimeout(refresh, 500);
  }, [saveAsName, onSaveAs, refresh]);

  const formatDate = (ts: number) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  // Stop pointer events from reaching the canvas
  const stopPropagation = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      onPointerDown={stopPropagation}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#0d1525',
          border: '1px solid #0f3460',
          borderRadius: 8,
          padding: 16,
          width: 420,
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          color: '#c0c8d0',
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#e94560' }}>Saved Worlds</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#556677', cursor: 'pointer', fontSize: 16,
          }}>{'\u2715'}</button>
        </div>

        {/* Save As */}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={saveAsName}
            onChange={e => setSaveAsName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSaveAs(); }}
            placeholder="Save current world as..."
            style={{
              flex: 1, padding: '4px 8px', background: '#1a2a4a', border: '1px solid #2a4a6a',
              borderRadius: 4, color: '#c0c8d0', fontSize: 12, outline: 'none',
            }}
          />
          <button
            onClick={handleSaveAs}
            disabled={!saveAsName.trim()}
            style={{
              padding: '4px 10px', background: '#1a3a2a', color: '#8ac060',
              border: '1px solid #3a5a2a', borderRadius: 4, cursor: 'pointer', fontSize: 12,
              opacity: saveAsName.trim() ? 1 : 0.4,
            }}
          >
            Save
          </button>
        </div>

        {/* World list */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {worlds.length === 0 && (
            <div style={{ color: '#556677', textAlign: 'center', padding: 16 }}>No saved worlds</div>
          )}
          {worlds.map(w => (
            <div
              key={w.name}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', background: '#0f1a30', borderRadius: 4,
                border: '1px solid #1a2a4a',
              }}
            >
              {renamingKey === w.name ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRename(w.name);
                    if (e.key === 'Escape') setRenamingKey(null);
                  }}
                  onBlur={() => handleRename(w.name)}
                  style={{
                    flex: 1, padding: '2px 6px', background: '#1a2a4a', border: '1px solid #e94560',
                    borderRadius: 3, color: '#c0c8d0', fontSize: 12, outline: 'none',
                  }}
                />
              ) : (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {w.name === 'autosave' ? 'Autosave' : w.name}
                  </div>
                  <div style={{ fontSize: 10, color: '#556677' }}>
                    {w.tileCount} tiles, {w.characterCount} chars — {formatDate(w.updatedAt)}
                  </div>
                </div>
              )}

              <button onClick={() => { onLoad(w.name); onClose(); }} style={{
                padding: '2px 8px', background: '#1a2a4a', color: '#60a0e0',
                border: '1px solid #2a4a6a', borderRadius: 3, cursor: 'pointer', fontSize: 11,
              }}>Load</button>

              {w.name !== 'autosave' && (
                <>
                  <button onClick={() => { setRenamingKey(w.name); setRenameValue(w.name); }} style={{
                    padding: '2px 6px', background: 'none', color: '#556677',
                    border: '1px solid transparent', borderRadius: 3, cursor: 'pointer', fontSize: 11,
                  }}>Ren</button>
                  <button onClick={() => handleDelete(w.name)} style={{
                    padding: '2px 6px', background: 'none', color: '#e94560',
                    border: '1px solid transparent', borderRadius: 3, cursor: 'pointer', fontSize: 11,
                  }}>Del</button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
