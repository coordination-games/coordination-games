import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import TournamentPage from './pages/TournamentPage';
import UnderConstructionPage from './pages/UnderConstructionPage';
import './index.css';

/** Minimal games.coop shell for standalone routes (no plugin registry needed). */
function SpectatorShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--color-bone)' }}>
      <div
        style={{
          background: 'var(--color-warm-black)',
          borderBottom: '1px solid rgba(2,226,172,0.18)',
        }}
      >
        <div
          className="max-w-5xl mx-auto px-4 sm:px-6 py-1.5 flex items-center justify-between text-[10px] font-mono tracking-[0.2em] uppercase"
          style={{ color: 'var(--color-ash)' }}
        >
          <span>games.coop / tournament</span>
          <span style={{ color: 'var(--color-mint)' }}>{'// spectator'}</span>
        </div>
      </div>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">{children}</div>
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/tournaments/:id',
    element: (
      <SpectatorShell>
        <TournamentPage />
      </SpectatorShell>
    ),
  },
  { path: '*', element: <UnderConstructionPage /> },
]);

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found in index.html');
}
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
