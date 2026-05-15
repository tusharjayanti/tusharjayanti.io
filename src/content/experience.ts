export interface RoleBulletGroup {
  heading?: string;
  bullets: string[];
}

export interface Role {
  slug: string;
  company: string;
  title: string;
  domain: string;
  location: string;
  startDate: string;
  endDate: string;
  current?: boolean;
  groups: RoleBulletGroup[];
}

export const experience: Role[] = [
  {
    slug: 'disco',
    company: 'DISCO',
    title: 'Senior Software Engineer (L4)',
    domain: 'Legal tech',
    location: 'Gurugram',
    startDate: 'Nov 2023',
    endDate: 'Sep 2025',
    groups: [
      {
        bullets: [
          'Led migration of authentication service from **.NET + RavenDB** (EOL, active CVEs) to **Kotlin + Spring Boot + PostgreSQL** on AWS, sequenced as two phases to close the security gap first.',
          "Authored a **C# library inspired by .NET's `IQueryable`** to run legacy .NET code against PostgreSQL during phase one, unblocking the database cutover.",
          'Owned the authorization service (**Python, FastAPI, Redis, PostgreSQL**) serving **~3,000 RPS** on the hot path of every authenticated request.',
          'Reduced authorization **p99 latency from 4.2s to ~1s (~75%)** by replacing a per-node permission-graph traversal with a bulk delete.',
          'Introduced **ELK structured logging with per-request correlation IDs**, enabling end-to-end request tracing across the service.',
          'Cut **CI times by 67%** by migrating Python tooling from `pipenv` to **`uv`**; drove adoption across other Python services in the org.',
          'Migrated authorization service from **REST to gRPC with Protocol Buffers** for strongly-typed service-to-service contracts.',
          'Co-designed a **Kotlin + gRPC service-to-service authorization system** issuing scoped credentials to internal services.',
          'Built a **Kotlin + GraphQL service** to resolve authorization decisions over hierarchical entity graphs with inherited permissions.',
          'Owned a batch maintenance service for redundant review databases, and the user-analytics service.',
          'Provisioned infrastructure with **Terraform**, making environment changes reviewable in PRs.',
          'Revamped engineer onboarding for the authorization team.',
        ],
      },
    ],
  },
  {
    slug: 'purpletoko',
    company: 'PurpleToko',
    title: 'Founding Engineer',
    domain: 'E-commerce',
    location: 'New Delhi',
    startDate: 'Oct 2022',
    endDate: 'Oct 2023',
    groups: [
      {
        bullets: [
          'Designed and built the backend architecture for a distributed **0→1 e-commerce platform on AWS** as the sole backend engineer.',
          'Implemented **Elasticsearch-based product and store search**, and **SQS-driven asynchronous pipelines** for order processing and payments.',
          'Designed **stateless services** for horizontal scaling and fault isolation.',
          'Translated ambiguous early-stage product requirements into shipped backend services. Left the platform in private beta.',
        ],
      },
    ],
  },
  {
    slug: 'transcend',
    company: 'Transcend Street Solutions',
    title: 'Software Engineer',
    domain: 'Fintech (Capital Markets)',
    location: 'Hyderabad (Remote)',
    startDate: 'Sep 2020',
    endDate: 'Sep 2022',
    groups: [
      {
        bullets: [
          'Engineered and launched the **Reserve Release** feature end-to-end on the booking service, eliminating duplicate trades caused by **FCM delays of up to 14 hours**.',
          'Reduced profile load latency **8x (6s to 700ms)** through SQL query restructuring and indexing.',
          'Migrated monolith modules to **Spring Boot microservices**, decoupling services that had been sharing state through the database.',
          'Built a **Spring Batch ingestion pipeline** for daily client financial data.',
          'Built **Airflow DAGs** to periodically read financial data and monitor high-value trading customer activity.',
          "Stood up **Kibana dashboards** for infrastructure monitoring across the team's services.",
        ],
      },
    ],
  },
  {
    slug: 'usaa',
    company: 'Baanyan Software Services (USAA)',
    title: 'Full Stack Java Developer',
    domain: 'Insurance',
    location: 'Plano, Texas',
    startDate: 'Aug 2018',
    endDate: 'Jul 2020',
    groups: [
      {
        bullets: [
          'Built **Spring Boot services** for the **P&C (Property & Casualty) Modernization** program, including **Kafka producers and consumers** for event-driven flows.',
          'Picked up **React** from scratch and shipped production frontend alongside backend services for the modules my team owned.',
          'Wrote **Python plugins for XL Release (XebiaLabs)** to extend GitLab CI pipelines with custom release-orchestration steps.',
          'Applied mutation testing on my own code using **PITest (Java)** and **Stryker (React)**.',
        ],
      },
    ],
  },
];
