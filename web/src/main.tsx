import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import './styles.css';
import { makeQueryClient } from './lib/query';
import { Find, Prints } from './student';
import { Darkroom, Icon } from './ui';

// The admin console is loaded only when an organiser opens it, so students download less.
const AdminApp = lazy(() => import('./admin').then((m) => ({ default: m.AdminApp as React.ComponentType })));

/** An address that leads nowhere: an empty frame in the red-lit room, and the way back to the events. */
function NotFound() {
  return (
    <main className="room nf">
      <div className="glow" aria-hidden />
      <div className="nf-in">
        <div className="nf-frame" aria-hidden>
          <span className="edge-print">Frame not found</span>
          <span className="nf-pic">
            <Icon name="search" size={34} />
          </span>
        </div>
        <h1>Nothing on this frame.</h1>
        <p>This page does not exist. The photos are on the events page.</p>
        <Link className="btn primary" to="/">
          See all events
        </Link>
      </div>
    </main>
  );
}

// The install prompt is kept until the first successful match (see My photos), not shown on arrival.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  (window as any).__installPrompt = e;
});

const queryClient = makeQueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Darkroom />
      <BrowserRouter>
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <Routes>
            {/* One Find screen and one Prints screen: moving between their addresses keeps the camera, the ticks and the open dialog's screen. */}
            {/* "/" is the home across all campuses, /c/<campus> one campus's own home (the old /?campus=x leads there). */}
            <Route path="/" element={<Find />} />
            <Route path="/c/:campus" element={<Find />} />
            <Route path="/e/:slug" element={<Find />} />
            <Route path="/e/:slug/find" element={<Find />} />
            <Route path="/e/:slug/mine" element={<Prints />} />
            <Route path="/e/:slug/album" element={<Prints />} />
            <Route path="/e/:slug/add" element={<Prints />} />
            <Route path="/e/:slug/me" element={<Prints />} />
            <Route path="/admin/*" element={<AdminApp />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
