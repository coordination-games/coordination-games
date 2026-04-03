import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import LobbiesPage from './pages/LobbiesPage';
import GamePage from './pages/GamePage';
import LeaderboardPage from './pages/LeaderboardPage';
import ReplayPage from './pages/ReplayPage';
import LobbyPage from './pages/LobbyPage';
import GamesPage from './pages/GamesPage';
import RegisterPage from './pages/RegisterPage';
import './index.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
