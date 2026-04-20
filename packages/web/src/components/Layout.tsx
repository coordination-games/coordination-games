import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `font-heading text-sm tracking-wider uppercase ${
    isActive
      ? 'text-[var(--color-amber-glow)] font-semibold'
      : 'text-[var(--color-parchment-dark)] hover:text-[var(--color-amber-glow)] transition-colors'
  }`;
}

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-parchment)' }}>
      {/* Dark wood header bar */}
      <header
        className="px-4 sm:px-6 py-3 sm:py-4"
        style={{
          background: 'linear-gradient(180deg, var(--color-wood) 0%, var(--color-wood-dark) 100%)',
          borderBottom: '2px solid var(--color-amber-dim)',
          boxShadow: '0 2px 12px rgba(42, 31, 14, 0.3)',
        }}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <NavLink
            to="/"
            className="flex items-center gap-2 sm:gap-3 hover:opacity-90 transition-opacity"
          >
            <span className="text-2xl sm:text-4xl" role="img" aria-label="lobster">
              🦞
            </span>
            <h1
              className="font-heading font-bold tracking-wide"
              style={{ color: 'var(--color-parchment)' }}
            >
              <span className="hidden sm:inline text-xl">Capture the Lobster</span>
              <span className="sm:hidden text-lg">CTL</span>
            </h1>
          </NavLink>
          {/* Desktop nav */}
          <nav className="hidden sm:flex items-center gap-6">
            <NavLink to="/" end className={navLinkClass}>
              Home
            </NavLink>
            <NavLink to="/lobbies" className={navLinkClass}>
              Lobbies
            </NavLink>
            <NavLink to="/leaderboard" className={navLinkClass}>
              Leaderboard
            </NavLink>
            <a
              href="https://github.com/lucianHymer/capture-the-lobster"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors"
              style={{ color: 'var(--color-parchment-dark)' }}
              title="GitHub"
            >
              {/* biome-ignore lint/a11y/noSvgWithoutTitle: pre-existing decorative svg; cleanup followup — TODO(2.3-followup) */}
              <svg className="w-5 h-5 hover:opacity-80" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
          </nav>
          {/* Mobile hamburger */}
          {/* biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup) */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="sm:hidden p-1 cursor-pointer"
            style={{ color: 'var(--color-parchment-dark)' }}
          >
            {/* biome-ignore lint/a11y/noSvgWithoutTitle: pre-existing decorative svg; cleanup followup — TODO(2.3-followup) */}
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile dropdown */}
        {menuOpen && (
          <nav
            className="sm:hidden mt-3 pt-3 flex flex-col gap-3"
            style={{ borderTop: '1px solid rgba(212, 162, 78, 0.2)' }}
          >
            <NavLink to="/" end className={navLinkClass} onClick={() => setMenuOpen(false)}>
              Home
            </NavLink>
            <NavLink to="/lobbies" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              Lobbies
            </NavLink>
            <NavLink to="/leaderboard" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              Leaderboard
            </NavLink>
            <a
              href="https://github.com/lucianHymer/capture-the-lobster"
              target="_blank"
              rel="noopener noreferrer"
              className="font-heading text-sm tracking-wider uppercase transition-colors"
              style={{ color: 'var(--color-parchment-dark)' }}
            >
              GitHub
            </a>
          </nav>
        )}
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-4 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
