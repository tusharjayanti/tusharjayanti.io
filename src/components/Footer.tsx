import { Link } from 'react-router';

export function Footer() {
  return (
    <footer className="app-footer">
      © 2026 Tushar Jayanti · <Link to="/privacy">privacy</Link> ·{' '}
      <a
        href="https://github.com/tusharjayanti/tusharjayanti.io"
        target="_blank"
        rel="noreferrer"
      >
        source
      </a>{' '}
      · v0.1.0
    </footer>
  );
}
