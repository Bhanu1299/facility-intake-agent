import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { AppProvider } from './context';
import { Layout } from './components/Layout';
import { ActivityPage } from './pages/ActivityPage';
import { InboxPage } from './pages/InboxPage';
import { Placeholder } from './pages/Placeholder';
import { RequestPage } from './pages/RequestPage';
import { SettingsPage } from './pages/SettingsPage';
import { SimulatorPage } from './pages/SimulatorPage';
import { WorkOrdersPage } from './pages/WorkOrdersPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* QR request portal: standalone, no app chrome, no login. */}
        <Route path="/r/:siteId" element={<RequestPage />} />
        <Route
          element={
            <AppProvider>
              <Layout />
            </AppProvider>
          }
        >
          <Route index element={<InboxPage />} />
          <Route path="work-orders" element={<WorkOrdersPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="simulator" element={<SimulatorPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Placeholder title="Not found" note="No such page." />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
