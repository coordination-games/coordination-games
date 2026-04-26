import { useState } from 'react';
import { NavLink, Outlet, useMatch } from 'react-router-dom';
import { GITHUB_REPO_URL } from '../config.js';
import { useActiveGame } from '../hooks/useActiveGame';

interface NavItem {
  num: string;
  label: string;
  to: string;
  end?: boolean;
}

const NAV: NavItem[] = [
  { num: '00', label: 'Home', to: '/', end: true },
  { num: '01', label: 'Lobbies', to: '/lobbies' },
  { num: '02', label: 'Leaderboard', to: '/leaderboard' },
];

function navItemClass({ isActive }: { isActive: boolean }) {
  return `font-mono text-[11px] tracking-[0.18em] uppercase transition-colors flex items-center gap-1.5 py-1 ${
    isActive
      ? 'text-[var(--color-mint-deep)]'
      : 'text-[var(--color-graphite)] hover:text-[var(--color-mint-deep)]'
  }`;
}

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { branding } = useActiveGame();
  const lobbyMatch = useMatch('/lobby/:id');
  const gameMatch = useMatch('/game/:id');
  const inspectMatch = useMatch('/inspect/:gameId');
  const replayMatch = useMatch('/replay/:id');
  const inGame = !!(lobbyMatch || gameMatch || inspectMatch || replayMatch);
  const fullBleedGameSurface = !!(gameMatch || inspectMatch || replayMatch);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bone)' }}>
      {/* Protocol stripe */}
      <div
        className="border-b"
        style={{ background: 'var(--color-warm-black)', borderColor: 'rgba(2,226,172,0.18)' }}
      >
        <div
          className="max-w-7xl mx-auto px-4 sm:px-6 py-1.5 flex items-center justify-between text-[10px] font-mono tracking-[0.2em] uppercase"
          style={{ color: 'var(--color-ash)' }}
        >
          <span>games.coop / v0.1</span>
          <span className="hidden sm:inline" style={{ color: 'var(--color-mint)' }}>
            {'// the future is shaped by the agents that coordinate best'}
          </span>
          <span className="sm:hidden" style={{ color: 'var(--color-mint)' }}>
            {'// coordination > intelligence'}
          </span>
        </div>
      </div>

      {/* Header */}
      <header
        className="px-4 sm:px-6"
        style={{ background: 'var(--color-bone)', borderBottom: '1px solid rgba(28,26,23,0.1)' }}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between h-16 sm:h-20">
          <NavLink to="/" className="flex items-center gap-3 group">
            {/* Mark — concentric arena ring */}
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              className="flex-none transition-transform group-hover:scale-105"
              aria-hidden="true"
            >
              <circle
                cx="16"
                cy="16"
                r="14"
                fill="none"
                stroke="var(--color-warm-black)"
                strokeWidth="1"
              />
              <circle
                cx="16"
                cy="16"
                r="9"
                fill="none"
                stroke="var(--color-warm-black)"
                strokeWidth="1"
              />
              <circle cx="16" cy="16" r="4" fill="var(--color-mint)" />
              <line
                x1="16"
                y1="2"
                x2="16"
                y2="9"
                stroke="var(--color-warm-black)"
                strokeWidth="1"
              />
              <line
                x1="16"
                y1="23"
                x2="16"
                y2="30"
                stroke="var(--color-warm-black)"
                strokeWidth="1"
              />
            </svg>
            <div className="leading-tight">
              <div
                className="font-display text-base sm:text-xl font-medium tracking-tight"
                style={{ color: 'var(--color-warm-black)' }}
              >
                Coordination Games
              </div>
              <div
                className="font-mono text-[9px] tracking-[0.22em] uppercase"
                style={{ color: 'var(--color-ash)' }}
              >
                games.coop
              </div>
            </div>
            {/* Active-game context badge */}
            {inGame && (
              <span
                className="hidden md:inline-flex items-center gap-1.5 ml-3 pl-3 border-l font-mono text-[10px] tracking-[0.18em] uppercase"
                style={{ borderColor: 'rgba(28,26,23,0.15)', color: 'var(--color-graphite)' }}
              >
                <span style={{ color: 'var(--color-ash)' }}>{'//'}</span>
                <span>{branding.shortName}</span>
              </span>
            )}
          </NavLink>

          {/* Desktop nav */}
          <nav className="hidden sm:flex items-center gap-7">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end ?? false} className={navItemClass}>
                <span style={{ color: 'var(--color-ash)' }}>{item.num}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] tracking-[0.18em] uppercase transition-colors flex items-center gap-1.5 py-1 hover:text-[var(--color-mint-deep)]"
              style={{ color: 'var(--color-graphite)' }}
              title="GitHub"
            >
              <span style={{ color: 'var(--color-ash)' }}>03</span>
              <span>Source</span>
            </a>
          </nav>

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="sm:hidden p-1 cursor-pointer"
            style={{ color: 'var(--color-warm-black)' }}
            aria-label="Toggle menu"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {menuOpen ? (
                <path
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                  strokeWidth={1.5}
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                  strokeWidth={1.5}
                  d="M4 7h16M4 12h16M4 17h16"
                />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile dropdown */}
        {menuOpen && (
          <nav
            className="sm:hidden pb-4 pt-2 flex flex-col gap-3"
            style={{ borderTop: '1px solid rgba(28,26,23,0.1)' }}
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end ?? false}
                className={navItemClass}
                onClick={() => setMenuOpen(false)}
              >
                <span style={{ color: 'var(--color-ash)' }}>{item.num}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] tracking-[0.18em] uppercase flex items-center gap-1.5 py-1"
              style={{ color: 'var(--color-graphite)' }}
            >
              <span style={{ color: 'var(--color-ash)' }}>03</span>
              <span>Source</span>
            </a>
          </nav>
        )}
      </header>

      <main
        className={`flex-1 w-full mx-auto ${
          fullBleedGameSurface ? 'max-w-none px-0 py-0' : 'max-w-7xl px-4 sm:px-6 py-6 sm:py-10'
        }`}
      >
        <Outlet />
      </main>

      {/* Footer */}
      <footer
        className="border-t mt-12"
        style={{ borderColor: 'rgba(28,26,23,0.1)', background: 'var(--color-bone)' }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div
            className="font-mono text-[10px] tracking-[0.2em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            <span style={{ color: 'var(--color-mint-deep)' }}>{'// '}</span>
            emergence &gt; control
            <span className="mx-2" style={{ color: 'var(--color-stone)' }}>
              ·
            </span>
            coordination &gt; intelligence
            <span className="mx-2" style={{ color: 'var(--color-stone)' }}>
              ·
            </span>
            systems &gt; individuals
          </div>
          <div
            className="font-mono text-[10px] tracking-[0.2em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            games.coop
          </div>
        </div>
      </footer>
    </div>
  );
}
