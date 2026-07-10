import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import './index.css';
import { CampaignsPage } from './pages/CampaignsPage';
import { ComparePage } from './pages/ComparePage';
import { DemosPage } from './pages/DemosPage';
import { JobPage } from './pages/JobPage';
import { NewCampaignPage } from './pages/NewCampaignPage';
import { RunPage } from './pages/RunPage';
import { SettingsPage } from './pages/SettingsPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DemosPage /> },
      { path: 'lab', element: <CampaignsPage /> },
      { path: 'new', element: <NewCampaignPage /> },
      { path: 'campaign/:campaignId/run/:runId', element: <RunPage /> },
      { path: 'job/:jobId', element: <JobPage /> },
      { path: 'compare', element: <ComparePage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}
