import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { GamePage } from './pages/GamePage';
import { CharacterEditor, TileEditor, WeaponEditor } from './editors';

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Navigation />
        <main style={{ flex: 1 }}>
          <Routes>
            <Route path="/" element={<GamePage />} />
            <Route path="/editor/character" element={<CharacterEditor />} />
            <Route path="/editor/weapon" element={<WeaponEditor />} />
            <Route path="/editor/tile" element={<TileEditor />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

function Navigation() {
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  const linkStyle = (path: string) => ({
    color: isActive(path) ? '#4ecca3' : '#ccc',
    textDecoration: 'none',
    fontWeight: isActive(path) ? 'bold' : 'normal',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
    background: isActive(path) ? 'rgba(78, 204, 163, 0.1)' : 'transparent',
  } as const);

  return (
    <nav style={{
      padding: '0.75rem 1rem',
      background: '#16213e',
      display: 'flex',
      gap: '0.5rem',
      alignItems: 'center',
    }}>
      <Link to="/" style={{ ...linkStyle('/'), fontWeight: 'bold' }}>
        Zap Architect
      </Link>
      <span style={{ color: '#333' }}>|</span>
      <Link to="/editor/character" style={linkStyle('/editor/character')}>
        Characters
      </Link>
      <Link to="/editor/weapon" style={linkStyle('/editor/weapon')}>
        Weapons
      </Link>
      <Link to="/editor/tile" style={linkStyle('/editor/tile')}>
        Tiles
      </Link>
    </nav>
  );
}
