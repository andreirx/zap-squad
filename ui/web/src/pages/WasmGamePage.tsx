/**
 * WASM Game Page - Full-screen WebGPU game
 */

import { useState, useEffect } from 'react';
import { WasmGame } from '../components/WasmGame';
import { createStorage } from '../storage';

export function WasmGamePage() {
  const [levels, setLevels] = useState<string[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<string | undefined>();
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Load available levels
  useEffect(() => {
    async function loadLevels() {
      try {
        const storage = createStorage();
        const files = await storage.list('levels');
        const levelIds = files
          .filter(f => f.endsWith('.json'))
          .map(f => f.replace('levels/', '').replace('.json', ''));
        setLevels(levelIds);
        if (levelIds.length > 0 && !selectedLevel) {
          setSelectedLevel(levelIds[0]);
        }
      } catch (e) {
        console.error('Failed to load levels:', e);
      }
    }
    loadLevels();
  }, [selectedLevel]);

  // Update dimensions on resize
  useEffect(() => {
    function updateDimensions() {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight - 50, // Leave room for header
      });
    }
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f23' }}>
      {/* Header */}
      <div style={{
        height: 50,
        background: '#16213e',
        display: 'flex',
        alignItems: 'center',
        padding: '0 1rem',
        gap: '1rem',
        borderBottom: '1px solid #333',
      }}>
        <h1 style={{ color: '#4ecca3', fontSize: '1.25rem', margin: 0 }}>
          ZapSquad (WebGPU)
        </h1>

        <select
          value={selectedLevel || ''}
          onChange={(e) => setSelectedLevel(e.target.value)}
          style={{
            background: '#0f0f23',
            border: '1px solid #333',
            borderRadius: '4px',
            padding: '0.5rem',
            color: '#ccc',
            fontSize: '0.875rem',
          }}
        >
          <option value="">Select Level</option>
          {levels.map(level => (
            <option key={level} value={level}>{level}</option>
          ))}
        </select>

        <div style={{ flex: 1 }} />

        <div style={{ color: '#666', fontSize: '0.75rem' }}>
          WASD/Arrows to move | Scroll to pan | Ctrl+Scroll to zoom
        </div>
      </div>

      {/* Game canvas */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <WasmGame
          levelId={selectedLevel}
          width={dimensions.width}
          height={dimensions.height}
          onError={(err) => console.error('Game error:', err)}
        />
      </div>
    </div>
  );
}

export default WasmGamePage;
