import { useLayoutEffect, useState } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
} from 'react-router';
import { Footer } from './components/Footer';
import { ModeToggle } from './components/ModeToggle';
import { Privacy } from './pages/Privacy';

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
  const showModeToggle =
    location.pathname === '/terminal' || location.pathname === '/cv';
  return (
    <div className="app-shell">
      {showModeToggle && <ModeToggle />}
      <main className="app-main">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function TerminalPlaceholder() {
  return (
    <section>
      <h1>terminal</h1>
      <p className="comment">// placeholder — wired in Chunk 3</p>
    </section>
  );
}

function CVPlaceholder() {
  return (
    <section>
      <h1>cv</h1>
      <p className="comment">// placeholder — wired in Chunk 2</p>
    </section>
  );
}

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <RootRedirect /> },
      { path: '/terminal', element: <TerminalPlaceholder /> },
      { path: '/cv', element: <CVPlaceholder /> },
      { path: '/privacy', element: <Privacy /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
