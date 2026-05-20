# Tushar Jayanti — Resume

## Summary

### Senior backend engineer building production agentic AI systems

Senior backend engineer with 7+ years building high-availability distributed systems and production SaaS platforms. Experienced in designing secure multi-tenant backend services, high-performance APIs, and event-driven architectures across Java, Kotlin, and Python. Currently building production agentic AI applications with FastAPI, Anthropic Claude, hybrid retrieval (semantic + BM25 via Reciprocal Rank Fusion) over Supabase pgvector, LLM-as-judge evaluation pipelines, and end-to-end LLM observability via Langfuse. Strong focus on scalable architecture, observability, and shipping reliable systems in fast-paced environments. Based in Bengaluru.

## Technical Skills

### Languages

Python, Java, Kotlin, C#, JavaScript, TypeScript. Strong in production-grade backend work across the JVM and Python ecosystems; comfortable picking up new languages quickly as projects demand.

### Backend frameworks and APIs

Senior-level expertise designing high-throughput backend services across multiple stacks. Production work in Spring Boot (Java/Kotlin), FastAPI and Flask (Python), and ASP.NET (C#). Strong API design across REST, gRPC with Protocol Buffers, and GraphQL. Built service-to-service communication patterns including request-response, fire-and-forget, and async event-driven architectures using Kafka, AWS SQS, and SNS. Experienced with microservices decomposition, monolith migrations, and event sourcing. Comfortable with both synchronous request paths (where p99 latency matters) and asynchronous pipelines (where throughput and resilience matter). Familiar with backend testing patterns including unit, integration, contract, and load testing. Specific framework experience: Spring Boot with Hibernate/JPA, FastAPI with Pydantic and asyncpg, Flask with SQLAlchemy migrated off ORM for performance.

### Databases and data infrastructure

PostgreSQL (primary), MSSQL, MongoDB. Strong on PostgreSQL specifically — query optimization, indexing strategies, JSONB workloads, generated columns, full-text search with ts_vector, and pgvector for embedding-based retrieval. Built custom LINQ-style C# to PostgreSQL query frameworks for type-safe data access. Operational experience with Redis (caching, rate limiting, distributed locks), Elasticsearch (search infrastructure at scale), and DynamoDB (key-value with sparse indexes). Comfortable with batch data pipelines via Apache Airflow, and with hybrid OLTP plus analytics workloads. Used Supabase Postgres in production for RAG storage.

### Cloud, DevOps, and observability

Production AWS experience across compute, messaging, storage, and identity primitives — building services on EC2 and ECS, async pipelines with SQS and SNS, object storage with S3, serverless functions with Lambda, managed databases with RDS, and access control with IAM. Strong on Docker and Kubernetes for containerization and orchestration, and on infrastructure as code via Terraform for reproducible deployments. CI/CD via GitLab CI and Jenkins, plus Vercel for edge-deployed services. Observability stack across Datadog (APM, metrics, logs), Prometheus and Grafana (custom dashboards), and Langfuse (LLM-specific tracing). Strong on distributed tracing for debugging cross-service issues. Reduced CI/CD pipeline duration by 67% and shrunk Docker image sizes via migration from pipenv to uv. Comfortable with on-call rotation, incident response, and post-incident reviews.

### AI, LLM, and ML systems

Production LLMOps work: integrated Anthropic Claude (Sonnet for generation, Haiku for evaluation and reranking) into customer-facing chat agents and customer-support automation. Built hybrid RAG pipelines combining semantic retrieval (Voyage voyage-3 asymmetric embeddings, 1024 dimensions, pgvector cosine) with lexical retrieval (Postgres ts_rank, BM25-family) fused via Reciprocal Rank Fusion. Designed LLM-as-judge evaluation pipelines for hallucination detection — Sonnet generator paired with Haiku judge, with heuristic prefilters reducing judge cost. Built end-to-end LLM observability via Langfuse with prompt versioning, cost computation per turn, and online quality scoring via deferred Haiku scoring. Designed agentic tool-use patterns with the Anthropic SDK including multi-step reasoning loops, structured tool definitions, and conversation state management. Familiar with context window management, prompt caching, and retrieval context compression. Designed eval-gated CI for LLM systems and closed-loop eval generation from production traces. Pre-LLM ML background: seq2seq neural NLP models in TensorFlow (encoder-decoder architectures, attention basics), classical ML with linear and logistic regression for OCR and CAPTCHA recognition — adversarial ML problems that grounded current intuitions around robustness and red-team-style evaluation of LLM systems.

## Experience

### Senior Software Engineer at DISCO — built and migrated identity and authorization platform (Nov 2023 – Sept 2025)

Led the multi-quarter migration of DISCO's mission-critical identity platform from .NET and RavenDB to Kotlin, Spring Boot, and PostgreSQL — owning the architecture decision, cutover plan, and zero-downtime deployment strategy. Migration shipped with zero customer-facing incidents over a 6-month rollout. Built and owned multi-tenant, permissions-aware identity and authorization services with audit logging, supporting enterprise-grade access control across thousands of customers. Reduced p99 latency on the Python authorization service from 4.2s to 1s (75%+ improvement) by replacing a per-node graph walk with a bulk delete strategy. Migrated the Python authorization service from REST to gRPC with Protocol Buffers, enabling strongly-typed contracts and lower-latency inter-service communication. Built a custom LINQ-style C# to PostgreSQL query framework that improved data access safety and developer productivity. Improved CI/CD pipeline speed by 67% and reduced Docker image sizes by migrating Python services from pipenv to uv. Provisioned and managed infrastructure using Terraform on AWS, improving deployment consistency. Mentored engineers and drove architectural best practices across platform services. Stack: Kotlin, Spring Boot, PostgreSQL, Python, FastAPI, Flask, gRPC, Protocol Buffers, Terraform, AWS, Datadog.

### Founding Engineer at PurpleToko — built 0-to-1 distributed e-commerce backend (Oct 2022 – Oct 2023)

Founding engineer at a fast-paced startup building a distributed e-commerce platform. Architected the backend systems on AWS for search, order processing, and payments — designing for horizontal scalability from day one with stateless services, async pipelines, and clear service boundaries. Implemented Elasticsearch-based search infrastructure for product discovery, and SQS-driven asynchronous pipelines for order processing and payment events — enabling resilient distributed processing under unpredictable startup load. Translated ambiguous product requirements into scalable backend systems and production-ready services, working closely with founders to ship incrementally and iterate based on real user feedback. Operated under tight resource constraints typical of a 0-to-1 environment, making pragmatic architecture decisions that balanced near-term velocity with long-term scalability. Stack: Java, Spring Boot, AWS (EC2, SQS, S3, RDS), Elasticsearch, PostgreSQL.

### Software Engineer at Transcend Street Solutions — built financial systems for high-throughput transactions (Sept 2020 – Sept 2022)

Engineered the Reserve Release feature end-to-end, preventing incorrect financial orders across 10,000+ daily transactions in a production financial system where correctness was non-negotiable. Optimized SQL workloads with targeted indexing and query rewriting, reducing latency 8x from 6 seconds to 700ms on critical query paths. Built and orchestrated batch data pipelines using Apache Airflow for reliable and observable workflow execution across financial data ingestion and processing. Migrated several monolith modules to Spring Boot microservices and built REST APIs for high-throughput workflows, decomposing tightly-coupled legacy code into independently deployable services. Worked across the stack on a financial system serving institutional clients with strict reliability and compliance requirements. Stack: Java, Spring Boot, MSSQL, Apache Airflow, REST APIs, microservices.

### Full Stack Java Developer at USAA (via Baanyan Software Services) — built event-driven financial services (Aug 2018 – Jul 2020)

Worked at USAA via Baanyan Software Services as a contracted Full Stack Java Developer, building event-driven financial processing services. Developed Spring Boot services integrated with Kafka-based event-driven architecture for high-throughput financial transaction processing — designing producer-consumer patterns, partition strategies, and consumer group failover. Created multiple Python plugins to extend functionality for third-party tools used in the financial workflow. Built monitoring dashboards using Prometheus and Grafana, improving observability and system reliability across the services I owned. Strong foundation in distributed messaging systems and observability patterns established during this period. Stack: Java, Spring Boot, Kafka, Python, Prometheus, Grafana.

## Projects

### Built production-grade agentic customer support AI with hallucination detection (vox-agent)

Production-grade agentic customer support AI built with FastAPI, asyncpg, and pgvector. Features inline hallucination-detection evaluation using Claude Sonnet as generator and Claude Haiku as LLM judge. Designed end-to-end backend architecture: async API layer with FastAPI and Pydantic v2, vector similarity retrieval over PostgreSQL with pgvector, structured LLM orchestration with Anthropic tool use, and structured Postgres logging for every conversation turn. Implemented retry and fallback orchestration across LLM providers via Protocol pattern abstraction, with zero real API calls in the 81-test suite (in-memory fakes throughout). Released as v0.1.0 with a documented architecture decision record and announced publicly on Twitter and LinkedIn. Key validation moment: the evaluator caught a real Sonnet hallucination live during smoke testing, validating the project's core thesis around inline LLM-as-judge evaluation. github.com/tusharjayanti/vox-agent

### Built production LLMOps portfolio with hybrid RAG and full observability (tusharjayanti.io)

Production LLMOps portfolio built around an agentic chat assistant powered by Claude Sonnet, designed to demonstrate end-to-end LLM operations competency at senior engineering level. Frontend: Vite, React 19, TypeScript. Backend: Vercel Edge Functions for API endpoints, Upstash Redis (Mumbai region) for chat logs and rate-limit counters, Supabase Postgres with pgvector for RAG storage. LLM stack: Anthropic Claude Sonnet for generation, Haiku for reranking and evaluation, Voyage voyage-3 for asymmetric embeddings, Langfuse (Tokyo region) for end-to-end LLM tracing with prompt versioning and cost computation. Hybrid retrieval pipeline: semantic similarity via pgvector HNSW cosine, lexical retrieval via Postgres ts_rank, fused via canonical Reciprocal Rank Fusion. Architectural decisions documented as ADRs in-repo. Roadmap covers observability foundation, agentic RAG with reranking and context compression, ops dashboard, eval-gated CI, online quality scoring, and closed-loop eval generation from production traces. tusharjayanti.io

### Built multi-agent job search automation system (job-search-copilot)

Personal multi-agent job search automation system used weekly for senior engineering job search in Bengaluru. Features 7 cooperating agents, 8-dimension A-to-F job scoring rubric, archetype detection across 6 role types, LaTeX resume tailoring via pdflatex automation, SQLite tracking with audit logging, and pluggable LLM provider design. Job sourcing tier: ATS API integration with Greenhouse, Ashby, and Lever, falling back to Wellfound and RSS, with selective scraping scoped to an allowlist of domains using jitter delays and user-agent rotation. Seniority normalization layer maps inconsistent role titles across sources. github.com/tusharjayanti/job-search-copilot

### Built seq2seq chatbot in TensorFlow as pre-LLM ML coursework

Built a seq2seq chatbot in TensorFlow around 2017–2018 using movie dialogue datasets, which gave first hands-on experience with training neural NLP models, preprocessing conversational data, and understanding encoder-decoder architectures that later informed current work on LLM agents and retrieval systems. github.com/tusharjayanti/TensorflowChatbot

### Built OCR system with classical ML for CAPTCHA recognition as pre-LLM ML coursework

Built an OCR system in Python and TensorFlow around 2017-2018 using linear and logistic regression for CAPTCHA recognition, focused on improving accuracy on small fonts and noisy image data. First encounter with adversarial ML problems and the limits of classical methods, which shaped current thinking around robustness and red-team-style evaluation in LLM agent work on hallucination detection and prompt injection defense. github.com/tusharjayanti/OpticalCharacterRecognition

## Education

### Master of Science in Computer Science at New Jersey Institute of Technology

Master of Science in Computer Science from New Jersey Institute of Technology. Coursework included machine learning fundamentals, software engineering principles, and distributed systems. Master's-era projects included the seq2seq TensorFlow chatbot and the OCR system using classical ML — pre-LLM ML work that grounded later intuitions for agentic AI systems.

### Bachelor of Technology in Electrical Engineering at Guru Gobind Singh Indraprastha University

Bachelor of Technology in Electrical Engineering from Guru Gobind Singh Indraprastha University (2016). Pre-CS degree that provided foundational training in systems thinking, signal processing, and mathematical fundamentals before transitioning to software engineering as a career.
