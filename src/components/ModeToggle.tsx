import { NavLink } from 'react-router';

export function ModeToggle() {
  return (
    <nav className="mode-toggle" aria-label="View mode">
      <NavLink to="/terminal" className={({ isActive }) => (isActive ? 'active' : '')}>
        terminal
      </NavLink>
      <NavLink to="/cv" className={({ isActive }) => (isActive ? 'active' : '')}>
        cv
      </NavLink>
    </nav>
  );
}
