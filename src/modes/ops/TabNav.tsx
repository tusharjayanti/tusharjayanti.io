// Horizontal tab row with a mauve active underline. Presentational —
// takes the tab list, the active id, and an onChange.

export interface TabDef {
  id: string;
  label: string;
}

interface TabNavProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}

export function TabNav({ tabs, active, onChange }: TabNavProps) {
  return (
    <nav className="ops-tabs" role="tablist" aria-label="ops sections">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          className={`ops-tab${t.id === active ? ' ops-tab--active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
