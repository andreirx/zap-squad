import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { GamePage } from './pages/GamePage';
import { WasmGamePage } from './pages/WasmGamePage';
import { FreedomBoardPage } from './freedom-board/FreedomBoardPage';
import { CharacterEditor, ObjectEditor, TileEditor, WeaponEditor, MapEditor } from './editors';

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Routes>
          {/* Freedom Board has its own full-screen layout (toolbar + canvas + status bar) */}
          <Route path="/" element={
            <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
              <Navigation />
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <FreedomBoardPage />
              </div>
            </div>
          } />

          {/* Legacy WASM game — retained as reference, not actively developed */}
          <Route path="/game/wasm" element={<WasmGamePage />} />

          {/* Legacy Canvas2D game page */}
          <Route path="/game/canvas2d" element={
            <>
              <Navigation />
              <main style={{ flex: 1 }}>
                <GamePage />
              </main>
            </>
          } />

          {/* Editors with shared navigation */}
          <Route path="/editor/*" element={
            <>
              <Navigation />
              <main style={{ flex: 1 }}>
                <Routes>
                  <Route path="character" element={<CharacterEditor />} />
                  <Route path="object" element={<ObjectEditor />} />
                  <Route path="weapon" element={<WeaponEditor />} />
                  <Route path="tile" element={<TileEditor />} />
                  <Route path="map" element={<MapEditor />} />
                </Routes>
              </main>
            </>
          } />
        </Routes>
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
      padding: '0.5rem 1rem',
      background: '#16213e',
      display: 'flex',
      gap: '0.5rem',
      alignItems: 'center',
      flexShrink: 0,
    }}>
      <Link to="/" style={{
        ...linkStyle('/'),
        fontWeight: 'bold',
        color: isActive('/') ? '#e94560' : '#ccc',
        background: isActive('/') ? 'rgba(233, 69, 96, 0.1)' : 'transparent',
      }}>
        Freedom Board
      </Link>
      <span style={{ color: '#333' }}>|</span>
      <Link to="/editor/tile" style={linkStyle('/editor/tile')}>
        Tiles
      </Link>
      <Link to="/editor/character" style={linkStyle('/editor/character')}>
        Characters
      </Link>
      <Link to="/editor/object" style={linkStyle('/editor/object')}>
        Objects
      </Link>
      <Link to="/editor/weapon" style={linkStyle('/editor/weapon')}>
        Weapons
      </Link>
      <Link to="/editor/map" style={linkStyle('/editor/map')}>
        Maps
      </Link>
      <span style={{ color: '#333' }}>|</span>
      <Link to="/game/canvas2d" style={linkStyle('/game/canvas2d')}>
        Canvas2D
      </Link>
      <Link to="/game/wasm" style={linkStyle('/game/wasm')}>
        WebGPU
      </Link>
    </nav>
  );
}
