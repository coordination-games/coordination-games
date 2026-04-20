import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import GamePage from './pages/GamePage';
import GamesPage from './pages/GamesPage';
import HomePage from './pages/HomePage';
import LeaderboardPage from './pages/LeaderboardPage';
import LobbiesPage from './pages/LobbiesPage';
import LobbyPage from './pages/LobbyPage';
import RegisterPage from './pages/RegisterPage';
import ReplayPage from './pages/ReplayPage';
// Phase 5.1: register web plugins at app boot. Order matters only when
// SlotHost renders multiple plugins for the same slot — chat is the only
// slot consumer today so any order is fine.
import { ChatSlotPlugin, registerWebPlugin } from './plugins';
import './index.css';

// Removing this single line removes chat from every shell that uses
// <SlotHost>. The acceptance test for Phase 5.1 leans on that property.
registerWebPlugin(ChatSlotPlugin);

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
      { path: '/leaderboard', element: <LeaderboardPage /> },
      { path: '/replay/:id', element: <ReplayPage /> },
    ],
  },
]);

// biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
