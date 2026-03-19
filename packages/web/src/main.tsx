import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import LobbiesPage from './pages/LobbiesPage';
import GamePage from './pages/GamePage';
import LeaderboardPage from './pages/LeaderboardPage';
import ReplayPage from './pages/ReplayPage';
import LobbyPage from './pages/LobbyPage';
import './index.css';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Navigate to="/lobbies" replace /> },
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
