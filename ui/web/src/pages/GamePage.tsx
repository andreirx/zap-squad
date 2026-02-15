import { useState, useCallback } from 'react';
import { useHotReload } from '../hooks/useHotReload';

export function GamePage() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { reload, isReloading, lastReloadTime } = useHotReload({
    onReloadStart: () => setStatus('loading'),
    onReloadComplete: () => setStatus('ready'),
    onReloadError: (error) => {
      setStatus('error');
      setErrorMessage(error.message);
    },
  });

  const handleReload = useCallback(async () => {
    await reload();
  }, [reload]);

  return (
    <div style={{ padding: '1rem' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        marginBottom: '1rem',
      }}>
        <button
          onClick={handleReload}
          disabled={isReloading}
          style={{
            padding: '0.75rem 1.5rem',
            background: isReloading ? '#555' : '#4ecca3',
            color: isReloading ? '#999' : '#1a1a2e',
            border: 'none',
            borderRadius: '4px',
            cursor: isReloading ? 'not-allowed' : 'pointer',
            fontWeight: 'bold',
            fontSize: '1rem',
          }}
        >
          {isReloading ? 'Reloading...' : 'Reload Mods'}
        </button>

        {lastReloadTime && (
          <span style={{ color: '#888', fontSize: '0.875rem' }}>
            Last reload: {lastReloadTime.toLocaleTimeString()}
          </span>
        )}

        {status === 'error' && (
          <span style={{ color: '#ff6b6b', fontSize: '0.875rem' }}>
            Error: {errorMessage}
          </span>
        )}
      </div>

      <div style={{
        background: '#0f0f23',
        borderRadius: '8px',
        padding: '2rem',
        textAlign: 'center',
      }}>
        <p style={{ color: '#888', marginBottom: '1rem' }}>
          Game canvas will appear here once WASM is built.
        </p>
        <p style={{ color: '#666', fontSize: '0.875rem' }}>
          Run <code style={{ background: '#222', padding: '0.25rem 0.5rem', borderRadius: '4px' }}>make wasm</code> to build the game engine.
        </p>

        {/* Placeholder for game canvas */}
        <div style={{
          width: '800px',
          height: '600px',
          background: '#111',
          margin: '1rem auto',
          borderRadius: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#444',
        }}>
          Game Canvas (800x600)
        </div>
      </div>
    </div>
  );
}
