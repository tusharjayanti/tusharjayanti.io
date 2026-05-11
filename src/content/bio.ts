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
    '7+ years shipping distributed systems across DISCO, PurpleToko, Transcend, and USAA. Now full-time on agentic systems.',
  availableFor: 'AI engineer or Senior Software Engineer roles. Open to both.',
} as const;

export type Bio = typeof bio;
