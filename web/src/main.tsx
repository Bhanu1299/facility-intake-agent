import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { Placeholder } from './pages/Placeholder';
import { RequestPage } from './pages/RequestPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/r/:siteId" element={<RequestPage />} />
        <Route element={<Layout />}>
          <Route
            index
            element={<Placeholder title="Inbox" note="Proposals for approval will appear here." />}
          />
          <Route
            path="work-orders"
            element={<Placeholder title="Work Orders" note="Approved work orders." />}
          />
          <Route
            path="activity"
            element={<Placeholder title="Activity Log" note="Every pipeline step and action." />}
          />
          <Route
            path="simulator"
            element={<Placeholder title="Sensor simulator" note="Demo tool." />}
          />
          <Route path="*" element={<Placeholder title="Not found" note="No such page." />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
