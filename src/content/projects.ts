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
    slug: 'portfolio',
    name: 'tusharjayanti.io (portfolio)',
    oneLiner: 'You are here. A production LLMOps system.',
    description:
      'Terminal-aesthetic portfolio with a grounded AI chat agent (Tarvis): agentic RAG over my own work, Langfuse-traced per turn, eval-gated CI, prompt-injection defense, and a private /ops observability dashboard. Vite + React + TypeScript on Vercel Edge, on free tiers.',
    stack: [
      'Vite',
      'React',
      'TypeScript',
      'Vercel',
      'Claude API',
      'Voyage',
      'Supabase',
      'pgvector',
      'Langfuse',
    ],
    github: 'https://github.com/tusharjayanti/tusharjayanti.io',
    status: 'shipped',
    highlight: true,
  },
  {
    slug: 'vox-agent',
    name: 'vox-agent',
    oneLiner: 'Text customer support agent + inline hallucination evals.',
    description:
      'Customer support AI with an inline hallucination-detection eval loop. Claude Sonnet generates responses, Claude Haiku acts as LLM judge. FastAPI + asyncpg + pgvector. An early agentic build; its inline-judge loop is the same eval-first instinct this site now runs at production scale.',
    stack: [
      'Python',
      'FastAPI',
      'Claude Sonnet',
      'Claude Haiku',
      'asyncpg',
      'pgvector',
    ],
    github: 'https://github.com/tusharjayanti/vox-agent',
    status: 'shipped',
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
    slug: 'tensorflow-chatbot',
    name: 'TensorFlow Chatbot',
    oneLiner: 'Seq2seq chatbot on the Cornell movie-dialogue corpus.',
    description:
      'A sequence-to-sequence (encoder-decoder) chatbot in TensorFlow, trained on the Cornell Movie Dialogue corpus. An early class project from the pre-LLM era; chunked the dataset to train on local hardware.',
    stack: ['Python', 'TensorFlow', 'seq2seq'],
    github: 'https://github.com/tusharjayanti/TensorflowChatbot',
    status: 'archived',
  },
  {
    slug: 'ocr',
    name: 'OCR',
    oneLiner: 'Character recognition from scratch with classical ML.',
    description:
      'Optical character recognition with classical ML: histogram features from vertical and horizontal projections, KNN for foreground/background segmentation, and logistic regression for character classification. An early, pre-deep-learning project.',
    stack: ['Python', 'KNN', 'logistic regression'],
    github: 'https://github.com/tusharjayanti/OpticalCharacterRecognition',
    status: 'archived',
  },
];
