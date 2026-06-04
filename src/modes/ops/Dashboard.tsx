// Dashboard shell: a controls row (window + test-traffic + logout) above a
// 6-tab nav, then the active tab's panel. Window/eval/tab state is in-memory
// for this slice. Overview is live against /api/ops/stats; the other five
// tabs are stubs until the M4 D-series wires their endpoints.

import { useState } from 'react';
import { TabNav, type TabDef } from './TabNav';
import { Overview } from './tabs/Overview';
import { Conversations } from './tabs/Conversations';
import { Rag } from './tabs/Rag';
import { Defense } from './tabs/Defense';
import { Evals } from './tabs/Evals';
import { System } from './tabs/System';
import { clearOpsCache } from '../../lib/opsApi';

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'rag', label: 'RAG' },
  { id: 'defense', label: 'Defense' },
  { id: 'evals', label: 'Evals' },
  { id: 'system', label: 'System' },
];

const WINDOWS = [1, 7, 30] as const;

interface DashboardProps {
  onUnauthorized: () => void;
}

export function Dashboard({ onUnauthorized }: DashboardProps) {
  const [windowDays, setWindowDays] = useState(7);
  const [includeEvals, setIncludeEvals] = useState(false);
  const [tab, setTab] = useState('overview');

  async function logout() {
    try {
      await fetch('/api/ops/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // best-effort; clearing local state + re-gating is what matters.
    }
    clearOpsCache();
    onUnauthorized();
  }

  return (
    <div className="ops-root">
      <header className="ops-header">
        <div className="ops-title">
          ops<span className="ops-title-slash">/</span>
        </div>
        <div className="ops-controls">
          <div className="ops-window" role="group" aria-label="window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                className={`ops-window-btn${
                  w === windowDays ? ' ops-window-btn--active' : ''
                }`}
                onClick={() => setWindowDays(w)}
              >
                {w}d
              </button>
            ))}
          </div>
          <label className="ops-toggle">
            <input
              type="checkbox"
              checked={includeEvals}
              onChange={(e) => setIncludeEvals(e.target.checked)}
            />
            <span>test traffic</span>
          </label>
          <button className="ops-logout" onClick={logout}>
            logout
          </button>
        </div>
      </header>

      <TabNav tabs={TABS} active={tab} onChange={setTab} />

      <main className="ops-body">
        {tab === 'overview' && (
          <Overview
            windowDays={windowDays}
            includeEvals={includeEvals}
            onUnauthorized={onUnauthorized}
          />
        )}
        {tab === 'conversations' && (
          <Conversations
            windowDays={windowDays}
            includeEvals={includeEvals}
            onUnauthorized={onUnauthorized}
          />
        )}
        {tab === 'rag' && (
          <Rag
            windowDays={windowDays}
            includeEvals={includeEvals}
            onUnauthorized={onUnauthorized}
          />
        )}
        {tab === 'defense' && (
          <Defense
            windowDays={windowDays}
            includeEvals={includeEvals}
            onUnauthorized={onUnauthorized}
          />
        )}
        {tab === 'evals' && <Evals onUnauthorized={onUnauthorized} />}
        {tab === 'system' && <System onUnauthorized={onUnauthorized} />}
      </main>
    </div>
  );
}
