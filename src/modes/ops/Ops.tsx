// Private /ops dashboard root. Injects a noindex meta on mount (the route
// is also behind auth, but noindex is belt-and-suspenders), probes the
// session via GET /api/ops/me, and renders either the password gate or the
// dashboard. Bare full-bleed: this route is mounted OUTSIDE the app shell,
// so there's no wordmark / mode-toggle / footer chrome.

import { useEffect, useState } from 'react';
import { PasswordGate } from './PasswordGate';
import { Dashboard } from './Dashboard';
import '../../styles/ops.css';

function useNoindex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    const prevTitle = document.title;
    document.title = 'ops/';
    return () => {
      document.head.removeChild(meta);
      document.title = prevTitle;
    };
  }, []);
}

export function Ops() {
  useNoindex();
  // null = still checking the session.
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/ops/me', { credentials: 'same-origin' })
      .then((res) => {
        if (alive) setAuthed(res.ok);
      })
      .catch(() => {
        if (alive) setAuthed(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (authed === null) {
    return <div className="ops-boot">ops/ · checking session…</div>;
  }
  if (!authed) {
    return <PasswordGate onSuccess={() => setAuthed(true)} />;
  }
  return <Dashboard onUnauthorized={() => setAuthed(false)} />;
}
