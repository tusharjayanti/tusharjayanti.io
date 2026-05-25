import { useLayoutEffect, useState } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
} from 'react-router';
import { Footer } from './components/Footer';
import { ModeToggle } from './components/ModeToggle';
import { OpsSnippet } from './components/OpsSnippet';
import { Wordmark } from './components/Wordmark';
import { CV } from './modes/cv/CV';
import { Terminal } from './modes/terminal/Terminal';
import { Privacy } from './pages/Privacy';
import { useIsMobile } from './lib/viewMode';

function RootRedirect() {
  const [target, setTarget] = useState<string | null>(null);
  useLayoutEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    setTarget(isMobile ? '/cv' : '/terminal');
  }, []);
  if (!target) return null;
  return <Navigate to={target} replace />;
}

function AppShell() {
  const location = useLocation();
  const isMobile = useIsMobile();
  const isMode =
    location.pathname === '/terminal' || location.pathname === '/cv';
  return (
    <div className={`app-shell${isMode ? ' app-shell--mode' : ''}`}>
      {isMode && (
        <div className="top-right-stack">
          <ModeToggle />
          {/* Desktop: ops snippet pinned top-right in the fixed stack.
              Mobile: rendered in flow below the wordmark (in app-main)
              instead, so it no longer overlaps the tagline. */}
          {!isMobile && <OpsSnippet />}
        </div>
      )}
      <main className="app-main">
        {isMode && <Wordmark />}
        {isMode && isMobile && <OpsSnippet />}
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <RootRedirect /> },
      { path: '/terminal', element: <Terminal /> },
      { path: '/cv', element: <CV /> },
      { path: '/privacy', element: <Privacy /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
