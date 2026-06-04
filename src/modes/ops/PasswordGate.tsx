// Catppuccin password gate. POSTs to /api/ops/login; on 200 the httpOnly
// session cookie is set server-side and we hand control to the dashboard.
// Distinct messaging for throttle (429) and misconfiguration (503).

import { useState } from 'react';

interface PasswordGateProps {
  onSuccess: () => void;
}

export function PasswordGate({ onSuccess }: PasswordGateProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ops/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      if (res.status === 429) setError('too many attempts — wait a minute');
      else if (res.status === 503) setError('ops auth not configured');
      else setError('invalid password');
    } catch {
      setError('network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops-gate">
      <form className="ops-gate-form" onSubmit={submit}>
        <div className="ops-title">
          ops<span className="ops-title-slash">/</span>
        </div>
        <p className="ops-gate-sub">private dashboard</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          aria-label="password"
          className="ops-gate-input"
        />
        <button
          type="submit"
          className="ops-gate-btn"
          disabled={busy || password.length === 0}
        >
          {busy ? '…' : 'enter'}
        </button>
        {error && <div className="ops-gate-error">{error}</div>}
      </form>
    </div>
  );
}
