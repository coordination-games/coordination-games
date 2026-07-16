import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from './api';
import type { PreflightReport } from './types';

const NAV = [
  { num: '00', label: 'Demos', to: '/' },
  { num: '01', label: 'Lab', to: '/lab' },
  { num: '02', label: 'Compare', to: '/compare' },
  { num: '03', label: 'Settings', to: '/settings' },
];

const PREFLIGHT_POLL_MS = 30_000;

/**
 * Amber bar under the header — one line per failing check's plain sentence,
 * visible everywhere so a failure surfaces before someone clicks a demo.
 * Silent when the console is healthy or unreachable; the fail-severity gate
 * matches PreflightReport.ok (warn-severity checks stay in Settings only).
 */
function PreflightBanner() {
  const [report, setReport] = useState<PreflightReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .preflight()
        .then((r) => {
          if (!cancelled) setReport(r);
        })
        .catch(() => {
          // Console unreachable is its own, more obvious signal — don't guess.
        });
    };
    check();
    const timer = setInterval(check, PREFLIGHT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!report || report.ok) return null;
  const failing = report.checks.filter((c) => !c.ok && c.severity === 'fail');
  if (failing.length === 0) return null;

  return (
    <div
      className="px-6 py-2 border-b flex flex-col gap-1"
      style={{ background: 'rgba(229, 181, 103, 0.1)', borderColor: 'var(--amber)' }}
    >
      {failing.map((c) => (
        <div key={c.id} className="font-mono text-xs" style={{ color: 'var(--amber)' }}>
          {c.detail ?? `${c.label} is failing.`}
        </div>
      ))}
      <NavLink
        to="/settings"
        className="font-mono text-xs underline w-fit"
        style={{ color: 'var(--amber)' }}
      >
        open settings
      </NavLink>
    </div>
  );
}

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
          <a
            href="/story"
            className="px-3 py-2 rounded font-mono text-xs"
            style={{ color: 'var(--ink-dim)' }}
          >
            <span style={{ opacity: 0.5 }}>04</span> story
          </a>
        </nav>
      </header>
      <PreflightBanner />
      <main className="flex-1 px-6 py-6 max-w-6xl w-full mx-auto">
        <Outlet />
      </main>
    </div>
  );
}
