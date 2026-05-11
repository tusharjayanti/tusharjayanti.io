import type { ReactNode } from 'react';
import { bio } from '../../../content/bio';
import { experience, type Role } from '../../../content/experience';
import { projects, type Project } from '../../../content/projects';
import { skills } from '../../../content/skills';

export type SectionKey =
  | 'bio'
  | 'experience'
  | 'projects'
  | 'skills'
  | 'contact';

export const sections: SectionKey[] = [
  'bio',
  'experience',
  'projects',
  'skills',
  'contact',
];

export function experienceSlugs(): string[] {
  return experience.map((r) => r.slug);
}

export function projectSlugs(): string[] {
  return projects.map((p) => p.slug);
}

export function allCatTargets(): string[] {
  return [...sections, ...experienceSlugs(), ...projectSlugs()];
}

export type Resolved =
  | { kind: 'section'; key: SectionKey }
  | { kind: 'role'; role: Role }
  | { kind: 'project'; project: Project }
  | { kind: 'not-found' };

export function resolveCatTarget(name: string): Resolved {
  if ((sections as string[]).includes(name)) {
    return { kind: 'section', key: name as SectionKey };
  }
  const role = experience.find((r) => r.slug === name);
  if (role) return { kind: 'role', role };
  const project = projects.find((p) => p.slug === name);
  if (project) return { kind: 'project', project };
  return { kind: 'not-found' };
}

function Line({ children }: { children: ReactNode }) {
  return <div className="term-line">{children}</div>;
}

export function renderBio(): ReactNode {
  return (
    <div className="term-block">
      <Line>{bio.name}</Line>
      <Line>{bio.title}</Line>
      <Line>
        {bio.location} · {bio.email} ·{' '}
        <a href={bio.github} target="_blank" rel="noreferrer">
          {bio.github.replace('https://', '')}
        </a>
      </Line>
      <Line>&nbsp;</Line>
      <Line>{bio.pitch}</Line>
      <Line>&nbsp;</Line>
      <Line>
        <span className="term-comment">// available for:</span>{' '}
        {bio.availableFor}
      </Line>
    </div>
  );
}

export function renderRole(role: Role): ReactNode {
  return (
    <div className="term-block">
      <Line>
        {role.title} @ {role.company}
      </Line>
      <Line>
        <span className="term-dim">
          {role.domain} · {role.location} · {role.startYear} — {role.endYear}
        </span>
      </Line>
      {role.bullets.map((b, i) => (
        <Line key={i}>
          <span
            className={b.includes('TODO') ? 'term-bullet-todo' : 'term-bullet'}
          >
            - {b}
          </span>
        </Line>
      ))}
    </div>
  );
}

export function renderExperienceAll(): ReactNode {
  return (
    <div className="term-block">
      {experience.map((r, i) => (
        <div key={r.slug}>
          {renderRole(r)}
          {i < experience.length - 1 && <Line>&nbsp;</Line>}
        </div>
      ))}
    </div>
  );
}

export function renderProject(project: Project): ReactNode {
  return (
    <div className="term-block">
      <Line>
        {project.highlight && <span className="term-star">★ </span>}
        {project.name}{' '}
        <span className={`term-status-${project.status}`}>
          [{project.status}]
        </span>
      </Line>
      <Line>{project.oneLiner}</Line>
      <Line>{project.description}</Line>
      <Line>
        <span className="term-dim">stack: {project.stack.join(', ')}</span>
      </Line>
      {project.roadmap && (
        <Line>
          <span className="term-comment">// roadmap:</span> {project.roadmap}
        </Line>
      )}
      {project.github && (
        <Line>
          <a href={project.github} target="_blank" rel="noreferrer">
            {project.github.replace('https://', '')}
          </a>
        </Line>
      )}
    </div>
  );
}

export function renderProjectsAll(): ReactNode {
  return (
    <div className="term-block">
      {projects.map((p, i) => (
        <div key={p.slug}>
          {renderProject(p)}
          {i < projects.length - 1 && <Line>&nbsp;</Line>}
        </div>
      ))}
    </div>
  );
}

export function renderSkills(): ReactNode {
  return (
    <div className="term-block">
      {skills.map((g) => (
        <Line key={g.label}>
          <span className="term-dim">{g.label.padEnd(12, ' ')}</span>
          {g.items.join(', ')}
        </Line>
      ))}
    </div>
  );
}

export function renderContact(): ReactNode {
  return (
    <div className="term-block">
      <Line>
        email:{'    '}
        <a href={`mailto:${bio.email}`}>{bio.email}</a>
      </Line>
      <Line>
        github:{'   '}
        <a href={bio.github} target="_blank" rel="noreferrer">
          {bio.github.replace('https://', '')}
        </a>
      </Line>
      <Line>
        linkedin:{' '}
        <a href={bio.linkedin} target="_blank" rel="noreferrer">
          {bio.linkedin.replace('https://', '')}
        </a>
      </Line>
      <Line>
        twitter:{'  '}
        <a href={bio.twitter} target="_blank" rel="noreferrer">
          {bio.twitter.replace('https://', '')}
        </a>
      </Line>
      <Line>
        resume:{'   '}
        <a href={bio.resume}>{bio.resume}</a>
      </Line>
    </div>
  );
}

export function renderSection(key: SectionKey): ReactNode {
  switch (key) {
    case 'bio':
      return renderBio();
    case 'experience':
      return renderExperienceAll();
    case 'projects':
      return renderProjectsAll();
    case 'skills':
      return renderSkills();
    case 'contact':
      return renderContact();
  }
}
