# Tushar Jayanti — Experience Corpus

## DISCO (Senior Software Engineer)

**Dates:** Nov 2023 – Sept 2025  
**Tech stack:** Python, FastAPI, Flask, Kotlin, Spring Boot, .NET, PostgreSQL, RavenDB, gRPC, Protocol Buffers, AWS, Terraform

### Identity platform migration

Led the multi-quarter migration of the company's core identity platform from .NET + RavenDB to Kotlin + Spring Boot + PostgreSQL. Owned the architecture decision, the cutover plan, and the zero-downtime deployment strategy. \Migration shipped with zero customer-facing incidents over a 6-month rollout.

### gRPC service-to-service architecture

Owned the design and rollout of gRPC service-to-service communication using Protocol Buffers. Wrote the internal RFC, got cross-team buy-in, and shipped the first 4 services. Set the pattern that the rest of the platform team followed.

### Modernized Oservability

Deployed a Terraform-managed sidecar to integrate a Python graph-based authorization service with ELK, and implemented Request ID-based distributed tracing — reducing production MTTR by ~80%.

### Performance optimization

Reduced p99 latency on the Authorization service from 4.2s to 1s — a 75%+ improvement. Profiled hot paths, redesigned the query layer, added connection pooling, and restructured how dependent services consumed identity data. Service now handles 5k+ TPS with 99.9% uptime under production load.

### Custom query framework

Built a LINQ-style C# to PostgreSQL query framework that the identity team used for all data access. Improved type safety, prevented SQL injection by construction, and made code review faster.

### CI/CD improvements

Migrated Python services from pipenv to uv. Reduced Docker image sizes by 40% and CI/CD pipeline time by 67%.

### Mentorship

Mentored two junior engineers through their first year, walked the team through architectural decisions in design reviews.

### Infrastructure

Provisioned and managed AWS infrastructure using Terraform. Set up monitoring with Datadog.

---

## PurpleToko (Founding Engineer)

**Dates:** Oct 2022 – Oct 2023  
**Tech stack:** Java, Node.js, Flutter, AWS (SQS, S3, RDS), Elasticsearch, React

### 0-to-1 backend architecture

Architected the backend systems on AWS for a distributed e-commerce platform. Designed for horizontal scalability from day one — stateless services, async pipelines, and clear service boundaries.

### Search infrastructure

Implemented Elasticsearch-based product search. Designed the indexing strategy, the query layer, and the relevance tuning.

### Async processing

Built SQS-driven asynchronous pipelines for order processing and payment workflows. Made the system resilient to downstream failures.

### Ambiguity navigation

Translated ambiguous product requirements into shippable systems. Worked directly with the founder on weekly priorities.

---

## Transcend Street Solutions (Software Engineer)

**Dates:** Sept 2020 – Sept 2022  
**Tech stack:** Java, Spring Boot, MSSQL, Apache Airflow, REST microservices, Kafka

### Reserve Release feature

Engineered the Reserve Release feature for a financial transaction platform processing 10k+ orders daily. Designed for idempotency to prevent duplicate financial actions. Worked with the compliance team to ensure audit trail completeness.

### SQL performance work

Improved application performance by optimizing heavy SQL queries (profile load decreased 8X from 6s to 700ms).

### Airflow pipelines

Built and orchestrated batch data pipelines using Apache Airflow. Replaced an ad-hoc cron-based system with proper DAG definitions, retry logic, and observability.

### Monolith decomposition

Migrated several modules from the legacy monolith into Spring Boot microservices. Built REST APIs for high-throughput payment workflows.

### batch loading financial data

Created a batch service using Spring Batch to ingest client financial data daily to our system

### On-call and incident response

Was primary on-call rotation for the financial transaction service. Led 3 P0 incident retrospectives. Wrote runbooks that reduced mean time to resolution.

---

## Baanyan Software Services (Full Stack Java Developer at USAA)

**Dates:** Aug 2018 – Jul 2020  
**Tech stack:** Java, Spring Boot, Kafka, Prometheus, Grafana

### Kafka event-driven architecture

Developed Spring Boot services integrated with Kafka for high-throughput financial transaction processing. Designed event schemas, partitioning strategy, and consumer group configuration.

### Observability

Built monitoring dashboards using Prometheus and Grafana. Established the SLO/SLI definitions for the team's services.

### Custom Python Plugins

Created multiple plugins using Python to add custom functionality for a third-party tool

### Frontend development with react

- Lead developer for all User-interface implementations using React

---

## Personal Projects

### Shortlist

Multi-agent job search copilot. 7 agents, 8-dimension scoring, archetype-aware resume tailoring, Postgres tracking, audit logging. Built with Anthropic Claude, Pydantic, and plain Python. github.com/tusharjayanti/shortlist

### Calculator agent

First Claude Code project. Built a tool-using calculator agent to learn LLM fundamentals — system prompts, tool definitions, parsing tool calls, conversation loops. github.com/tusharjayanti/calculator-agent

### Vox-agent

Text-based customer support AI with inline hallucination detection. Used Claude Sonnet as the generator, Claude Haiku as the LLM judge. FastAPI + asyncpg + pgvector. github.com/tusharjayanti/vox-agent

### Intelligent Chatbot github.com/tusharjayanti/TensorflowChatbot

• Built a seq2seq chatbot using Python and TensorFlow, trained on a movie dialogue dataset to generate
contextually relevant responses. github.com/tusharjayanti/TensorflowChatbot

### Optical Character Recognition github.com/tusharjayanti/OpticalCharacterRecognition

• Developed an OCR system using Linear and Logistic Regression in Python and TensorFlow to improve
accuracy on small fonts and noisy image data for CAPTCHA recognition.
github.com/tusharjayanti/OpticalCharacterRecognition

---

## Education

**Master of Science in Computer Science** — New Jersey Institute of Technology, 2018  
**Bachelor of Technology in Electrical Engineering** — Guru Gobind Singh Indraprastha University, 2016
