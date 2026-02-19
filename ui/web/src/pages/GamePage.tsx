import { useState, useCallback, useEffect } from 'react';
import { useHotReload } from '../hooks/useHotReload';
import { GameCanvas } from '../components/GameCanvas';
import { createStorage } from '../storage';

export function GamePage() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [availableLevels, setAvailableLevels] = useState<string[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null);

  const { reload, isReloading, lastReloadTime } = useHotReload({
    onReloadStart: () => setStatus('loading'),
    onReloadComplete: () => setStatus('ready'),
    onReloadError: (error) => {
      setStatus('error');
      setErrorMessage(error.message);
    },
  });

  // Load available levels on mount
  useEffect(() => {
    async function loadLevels() {
      try {
        const storage = createStorage();
        const files = await storage.list('levels');
        const levels = files
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace('levels/', '').replace('.json', ''));
        setAvailableLevels(levels);
        if (levels.length > 0 && !selectedLevel) {
          setSelectedLevel(levels[0]);
        }
      } catch (e) {
        console.error('Failed to load levels:', e);
      }
    }
    loadLevels();
  }, [selectedLevel]);

  const handleReload = useCallback(async () => {
    await reload();
    // Refresh levels list after reload
    const storage = createStorage();
    const files = await storage.list('levels');
    const levels = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('levels/', '').replace('.json', ''));
    setAvailableLevels(levels);
  }, [reload]);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)' }}>
      {/* Sidebar */}
      <div
        style={{
          width: 220,
          background: '#16213e',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <h3 style={{ color: '#4ecca3', margin: 0 }}>Levels</h3>

        <div
          style={{
            flex: 1,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
          }}
        >
          {availableLevels.length === 0 ? (
            <div style={{ color: '#666', fontSize: '0.875rem' }}>
              No levels found.
              <br />
              Import from hexmanos or create in Map Editor.
            </div>
          ) : (
            availableLevels.map((level) => (
              <button
                key={level}
                onClick={() => setSelectedLevel(level)}
                style={{
                  padding: '0.5rem',
                  background: level === selectedLevel ? '#4ecca3' : '#0f0f23',
                  color: level === selectedLevel ? '#1a1a2e' : '#ccc',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '0.875rem',
                }}
              >
                {level}
              </button>
            ))
          )}
        </div>

        <div style={{ borderTop: '1px solid #333', paddingTop: '1rem' }}>
          <button
            onClick={handleReload}
            disabled={isReloading}
            style={{
              width: '100%',
              padding: '0.75rem',
              background: isReloading ? '#555' : '#4ecca3',
              color: isReloading ? '#999' : '#1a1a2e',
              border: 'none',
              borderRadius: '4px',
              cursor: isReloading ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
            }}
          >
            {isReloading ? 'Reloading...' : 'Reload Mods'}
          </button>

          {lastReloadTime && (
            <div
              style={{
                color: '#666',
                fontSize: '0.75rem',
                marginTop: '0.5rem',
                textAlign: 'center',
              }}
            >
              Last: {lastReloadTime.toLocaleTimeString()}
            </div>
          )}

          {status === 'error' && (
            <div
              style={{
                color: '#ff6b6b',
                fontSize: '0.75rem',
                marginTop: '0.5rem',
              }}
            >
              {errorMessage}
            </div>
          )}
        </div>
      </div>

      {/* Main canvas area */}
      <div style={{ flex: 1, position: 'relative' }}>
        <GameCanvas
          levelId={selectedLevel || undefined}
          style={{ width: '100%', height: '100%' }}
          onEntityClick={(entity) => {
            console.log('Clicked entity:', entity);
          }}
        />

        {/* Status bar */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '0.5rem 1rem',
            background: 'rgba(0, 0, 0, 0.7)',
            color: '#888',
            fontSize: '0.75rem',
            display: 'flex',
            gap: '2rem',
          }}
        >
          <span>Level: {selectedLevel || 'None'}</span>
          <span style={{ color: '#666' }}>
            Scroll to zoom, Middle-click or Space+drag to pan
          </span>
        </div>
      </div>
    </div>
  );
}
