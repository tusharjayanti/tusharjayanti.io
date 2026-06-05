export const bio = {
  name: 'Tushar Jayanti',
  title: 'Senior backend engineer building agentic systems',
  location: 'Bengaluru, India',
  email: 'tj@tusharjayanti.io',
  github: 'https://github.com/tusharjayanti',
  linkedin: 'https://linkedin.com/in/tusharjayanti',
  twitter: 'https://twitter.com/tusharjayanti',
  resume: '/resume.pdf',
  pitch:
    '7+ years shipping distributed systems across DISCO, PurpleToko, Transcend, and USAA. Now full-time on agentic AI; this site is the flagship, a production LLMOps system.',
  availableFor: 'AI engineer or Senior Software Engineer roles. Open to both.',
} as const;

export type Bio = typeof bio;

export const whoami: string = `Senior engineer, seven years on distributed backend systems in production. Language-agnostic by training, Java/Kotlin/Python in practice.

Now building agentic systems on top of that foundation. The flagship is this site itself, a production LLMOps system, with vox-agent and shortlist around it. The ML and AI work isn't entirely new ground, coursework and projects during my masters, but the application to production systems is where the recent energy is going.

What I actually like: scale, building AI agents that are grounded, and product engineering. Roughly in that order.`;
