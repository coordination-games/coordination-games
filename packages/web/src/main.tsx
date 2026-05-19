import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import UnderConstructionPage from './pages/UnderConstructionPage';
import './index.css';

const router = createBrowserRouter([{ path: '*', element: <UnderConstructionPage /> }]);

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found in index.html');
}
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
