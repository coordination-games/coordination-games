import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { num: '00', label: 'Campaigns', to: '/' },
  { num: '01', label: 'New Campaign', to: '/new' },
  { num: '02', label: 'Compare Models', to: '/compare' },
  { num: '03', label: 'Settings', to: '/settings' },
];

export function App() {
  return (
    <div className="min-h-full flex flex-col">
      <header
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{ borderColor: 'var(--line)' }}
      >
        <div>
          <div className="font-display text-lg font-600" style={{ color: 'var(--mint)' }}>
            Campaign Console
          </div>
          <div className="label">coordination games · research harness</div>
        </div>
        <nav className="flex gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className="px-3 py-2 rounded font-mono text-xs"
              style={({ isActive }) => ({
                color: isActive ? 'var(--mint)' : 'var(--ink-dim)',
                background: isActive ? 'var(--panel-2)' : 'transparent',
              })}
            >
              <span style={{ opacity: 0.5 }}>{item.num}</span> {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 px-6 py-6 max-w-6xl w-full mx-auto">
        <Outlet />
      </main>
    </div>
  );
}
