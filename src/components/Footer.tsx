import { Link } from 'react-router';
import { version } from '../../package.json';

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
      · v{version}
    </footer>
  );
}
