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
    '7+ years shipping distributed systems across DISCO, PurpleToko, Transcend, and USAA. Now full-time on a stealth AI content-detection venture; this site itself is a production LLMOps system I built.',
  availableFor: 'AI engineer or Senior Software Engineer roles. Open to both.',
} as const;

export type Bio = typeof bio;

export const whoami: string = `Senior engineer, seven years on distributed backend systems in production. Language-agnostic by training, Java/Kotlin/Python in practice.

Now building agentic systems on top of that foundation. Current focus is a stealth venture in AI content-detection: feed it content, get back whether it's AI-generated and which model family made it, with calibrated confidence, and the hard part is holding accuracy up against humanizers. Around that, this site itself is a production LLMOps system, with vox-agent and shortlist alongside. The ML and AI work isn't entirely new ground, coursework and projects during my masters, but the application to production systems is where the recent energy is going.

What I actually like: scale, building AI agents that are grounded, and product engineering. Roughly in that order.`;
