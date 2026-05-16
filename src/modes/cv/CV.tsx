import { SiGithub, SiX } from 'react-icons/si';
import { FaLinkedin } from 'react-icons/fa6';
import { LuMail } from 'react-icons/lu';
import { bio } from '../../content/bio';
import { experience, type Role } from '../../content/experience';
import { projects, type Project } from '../../content/projects';
import { skills } from '../../content/skills';

function renderBullet(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}

function Hero() {
  return (
    <header className="cv-hero">
      <p className="cv-meta">
        {bio.location} · <a href={`mailto:${bio.email}`}>{bio.email}</a> ·{' '}
        <a href={bio.github} target="_blank" rel="noreferrer">
          github
        </a>{' '}
        · <a href={bio.resume}>resume</a>
      </p>
      <p className="cv-pitch">{bio.pitch}</p>
      <p className="cv-available">
        <span className="comment">// available for:</span> {bio.availableFor}
      </p>
    </header>
  );
}

function ExperienceItem({ role }: { role: Role }) {
  const dates = `${role.startDate} - ${role.endDate}`;
  return (
    <article className="role">
      <header className="role-header">
        <h3 className="role-title">
          {role.title} <span className="role-at">@</span>{' '}
          <span className="role-company">{role.company}</span>
        </h3>
        <div className="role-meta">
          <span>{role.domain}</span>
          <span>·</span>
          <span>{role.location}</span>
          <span>·</span>
          <span>{dates}</span>
        </div>
      </header>
      {role.groups.map((g, gi) => (
        <div key={gi} className="role-group">
          {g.heading && <h4 className="role-group-heading">{g.heading}</h4>}
          <ul className="role-bullets">
            {g.bullets.map((b, i) => (
              <li key={i} className="bullet">
                {renderBullet(b)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </article>
  );
}

function ExperienceSection() {
  return (
    <section className="cv-section">
      <h2 className="section-title">experience</h2>
      {experience.map((r) => (
        <ExperienceItem key={r.slug} role={r} />
      ))}
    </section>
  );
}

function StatusPill({ status }: { status: Project['status'] }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function ProjectItem({ project }: { project: Project }) {
  const className = project.highlight ? 'project project-highlight' : 'project';
  return (
    <article className={className}>
      <header className="project-header">
        <h3 className="project-name">
          {project.highlight && <span className="project-star">★ </span>}
          {project.name}
        </h3>
        <StatusPill status={project.status} />
      </header>
      <p className="project-oneliner">{project.oneLiner}</p>
      <p className="project-description">{project.description}</p>
      <div className="project-stack">
        {project.stack.map((s) => (
          <span key={s} className="stack-chip">
            {s}
          </span>
        ))}
      </div>
      {project.roadmap && (
        <p className="project-roadmap">
          <span className="comment">// roadmap:</span> {project.roadmap}
        </p>
      )}
      {project.github && (
        <p className="project-link">
          <a href={project.github} target="_blank" rel="noreferrer">
            {project.github.replace('https://', '')}
          </a>
        </p>
      )}
    </article>
  );
}

function ProjectsSection() {
  return (
    <section className="cv-section">
      <h2 className="section-title">projects</h2>
      {projects.map((p) => (
        <ProjectItem key={p.slug} project={p} />
      ))}
    </section>
  );
}

function SkillsSection() {
  return (
    <section className="cv-section">
      <h2 className="section-title">skills</h2>
      <div className="skills-groups">
        {skills.map((g) => (
          <div key={g.label} className="skill-group">
            <h3 className="skill-group-label">{g.label}</h3>
            <div className="skill-chips">
              {g.items.map((item) => (
                <span key={item} className="stack-chip">
                  {item}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type ContactLink = {
  label: string;
  href: string;
  icon: React.ComponentType<{ 'aria-hidden'?: boolean }>;
  external: boolean;
};

const contactLinks: ContactLink[] = [
  { label: 'github', href: bio.github, icon: SiGithub, external: true },
  { label: 'linkedin', href: bio.linkedin, icon: FaLinkedin, external: true },
  { label: 'twitter', href: bio.twitter, icon: SiX, external: true },
  {
    label: 'email',
    href: `mailto:${bio.email}`,
    icon: LuMail,
    external: false,
  },
];

function ContactSection() {
  return (
    <section className="cv-section">
      <h2 className="section-title">contact</h2>
      <p className="contact-comment">// four doors. email is the fast one.</p>
      <nav className="contact-icons" aria-label="Contact links">
        {contactLinks.map(({ label, href, icon: Icon, external }) => (
          <a
            key={label}
            href={href}
            aria-label={label}
            {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            <Icon aria-hidden />
            <span className="contact-label">{label}</span>
          </a>
        ))}
      </nav>
    </section>
  );
}

export function CV() {
  return (
    <div className="cv">
      <Hero />
      <ExperienceSection />
      <ProjectsSection />
      <SkillsSection />
      <ContactSection />
    </div>
  );
}
