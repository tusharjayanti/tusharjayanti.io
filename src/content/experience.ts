export interface Role {
  slug: string;
  company: string;
  title: string;
  domain: string;
  location: string;
  startYear: string;
  endYear: string;
  current?: boolean;
  bullets: string[];
}

const todoBullets = (): string[] => [
  'Owned [scope] across [N] services — TODO: real bullet from drafting session',
  'Reduced [metric] from [X] → [Y] — TODO: real numbers',
  'Mentored [N] engineers / shipped [thing] — TODO: real outcome',
];

export const experience: Role[] = [
  {
    slug: 'disco',
    company: 'DISCO',
    title: 'Senior Backend Engineer',
    domain: 'Legal tech',
    location: 'Gurugram',
    startYear: '2023',
    endYear: '2025',
    bullets: todoBullets(),
  },
  {
    slug: 'purpletoko',
    company: 'PurpleToko',
    title: 'Founding Engineer',
    domain: 'E-commerce',
    location: 'Remote',
    startYear: '2022',
    endYear: '2023',
    bullets: todoBullets(),
  },
  {
    slug: 'transcend',
    company: 'Transcend Street Solutions',
    title: 'Software Engineer',
    domain: 'Fintech (Capital Markets)',
    location: 'Remote',
    startYear: '2020',
    endYear: '2022',
    bullets: todoBullets(),
  },
  {
    slug: 'usaa',
    company: 'Baanyan Software Services (USAA)',
    title: 'Software Engineer',
    domain: 'Fintech',
    location: 'United States',
    startYear: '2018',
    endYear: '2020',
    bullets: todoBullets(),
  },
];
