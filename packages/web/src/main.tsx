import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
// Phase 5.1: register web plugins at app boot. Order matters only when
// SlotHost renders multiple plugins for the same slot — chat is the only
// universal slot consumer today; per-game plugins (Phase 6.3) are filtered
// by `gameType` in SlotHost so order between them doesn't matter.
import { CaptureTheLobsterWebPlugin } from './games/capture-the-lobster/webPlugin';
import { OathbreakerWebPlugin } from './games/oathbreaker/webPlugin';
import { TragedyOfTheCommonsWebPlugin } from './games/tragedy-of-the-commons/webPlugin';
import GamePage from './pages/GamePage';
import GamesPage from './pages/GamesPage';
import HomePage from './pages/HomePage';
import InspectorPage from './pages/InspectorPage';
import LeaderboardPage from './pages/LeaderboardPage';
import LobbiesPage from './pages/LobbiesPage';
import LobbyPage from './pages/LobbyPage';
import RegisterPage from './pages/RegisterPage';
import ReplayPage from './pages/ReplayPage';
import { ChatSlotPlugin, registerWebPlugin } from './plugins';
import './index.css';

// Removing this single line removes chat from every shell that uses
// <SlotHost>. The acceptance test for Phase 5.1 leans on that property.
registerWebPlugin(ChatSlotPlugin);
// Phase 6.3: per-game `lobby:card` providers. Each plugin declares its
// `gameType` and SlotHost dispatches lobby/game cards accordingly.
registerWebPlugin(CaptureTheLobsterWebPlugin);
registerWebPlugin(OathbreakerWebPlugin);
registerWebPlugin(TragedyOfTheCommonsWebPlugin);

const router = createBrowserRouter([
  // Standalone pages (no shared layout)
  { path: '/games', element: <GamesPage /> },
  { path: '/register', element: <RegisterPage /> },
  // CtL pages (shared parchment layout)
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/lobbies', element: <LobbiesPage /> },
      { path: '/lobby/:id', element: <LobbyPage /> },
      { path: '/game/:id', element: <GamePage /> },
      { path: '/inspect/:gameId', element: <InspectorPage /> },
      { path: '/leaderboard', element: <LeaderboardPage /> },
      { path: '/replay/:id', element: <ReplayPage /> },
    ],
  },
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
