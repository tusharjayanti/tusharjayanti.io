export type ProjectStatus = 'shipped' | 'in-progress' | 'archived';

export interface Project {
  slug: string;
  name: string;
  oneLiner: string;
  description: string;
  stack: string[];
  github?: string;
  roadmap?: string;
  status: ProjectStatus;
  highlight?: boolean;
}

export const projects: Project[] = [
  {
    slug: 'calculator-agent',
    name: 'calculator-agent',
    oneLiner: 'Tool-calling agent. First production AI project.',
    description:
      'Multi-step tool-calling agent that decomposes natural-language math problems into discrete operations. Demonstrates Claude tool use, error recovery, and structured output handling.',
    stack: ['Python', 'Claude API', 'Tool use'],
    github: 'https://github.com/tusharjayanti/calculator-agent',
    status: 'shipped',
  },
  {
    slug: 'vox-agent',
    name: 'vox-agent',
    oneLiner: 'Text customer support agent + inline hallucination evals.',
    description:
      'Customer support AI with an inline hallucination-detection eval loop. Claude Sonnet generates responses, Claude Haiku acts as LLM judge. FastAPI + asyncpg + pgvector. Built as my LLMOps reference project.',
    stack: [
      'Python',
      'FastAPI',
      'Claude Sonnet',
      'Claude Haiku',
      'asyncpg',
      'pgvector',
    ],
    github: 'https://github.com/tusharjayanti/vox-agent',
    roadmap: 'v0.2: adding RAG over product docs + closed-loop eval generation',
    status: 'shipped',
    highlight: true,
  },
  {
    slug: 'shortlist',
    name: 'shortlist',
    oneLiner: 'Multi-agent job search copilot I use weekly.',
    description:
      'Six AI agents score jobs across 8 dimensions and tailor LaTeX resumes from a career corpus. Corpus-grounded. No hallucinated experience. I use it weekly.',
    stack: ['Python', 'Pydantic', 'Claude API', 'PostgreSQL', 'LaTeX'],
    github: 'https://github.com/tusharjayanti/shortlist',
    status: 'shipped',
  },
  {
    slug: 'portfolio',
    name: 'portfolio (this site)',
    oneLiner: 'You are here.',
    description:
      'Terminal-aesthetic portfolio with dual-mode rendering (terminal + CV) and an AI chat command. Vite + React + TypeScript on Vercel. Eventually a production LLMOps reference.',
    stack: ['Vite', 'React', 'TypeScript', 'Vercel', 'Claude API'],
    status: 'in-progress',
  },
];
