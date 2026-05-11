export interface SkillGroup {
  label: string;
  items: string[];
}

export const skills: SkillGroup[] = [
  {
    label: 'languages',
    items: ['Python', 'Java', 'Kotlin', 'TypeScript', 'JavaScript', 'SQL'],
  },
  {
    label: 'backend',
    items: [
      'Spring Boot',
      'FastAPI',
      'gRPC',
      'REST',
      'GraphQL',
      'Kafka',
      'Event-driven architecture',
    ],
  },
  {
    label: 'data',
    items: [
      'PostgreSQL',
      'Elasticsearch',
      'Redis',
      'MongoDB',
      'DynamoDB',
      'pgvector',
      'Apache Airflow',
    ],
  },
  {
    label: 'infra',
    items: [
      'AWS',
      'Docker',
      'Kubernetes',
      'Terraform',
      'GitLab CI',
      'Jenkins',
      'Datadog',
    ],
  },
  {
    label: 'ai / llms',
    items: [
      'Claude API',
      'Tool use',
      'RAG',
      'LLM evals',
      'Multi-agent systems',
      'Prompt engineering',
    ],
  },
];
