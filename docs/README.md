# Documentation

Welcome to the **model_proxy_v3** documentation. This directory contains all project documentation.

## 📚 Table of Contents

### Getting Started
- [Installation](./getting-started/installation.md) - How to install and set up the project
- [Quick Start](./getting-started/quick-start.md) - Get up and running in minutes
- [Configuration](./getting-started/configuration.md) - Configuration options and examples

### Architecture
- [Overview](./architecture/overview.md) - High-level architecture diagram and concepts
- [Components](./architecture/components.md) - Core components and their responsibilities
- [Data Flow](./architecture/data-flow.md) - How data moves through the system

### API Reference
- [REST API](./api/rest-api.md) - REST endpoints and usage
- [WebSocket API](./api/websocket-api.md) - Real-time communication
- [Authentication](./api/authentication.md) - Auth mechanisms and tokens
- [Rate Limiting](./api/rate-limiting.md) - API limits and best practices

### Development
- [Local Development](./development/local-development.md) - Setting up a dev environment
- [Testing](./development/testing.md) - Test strategy and how to run tests
- [Contributing](./development/contributing.md) - Contribution guidelines
- [Code Style](./development/code-style.md) - Coding standards and linting

### Deployment
- [Docker](./deployment/docker.md) - Containerization guide
- [Kubernetes](./deployment/kubernetes.md) - K8s deployment manifests
- [Environment Variables](./deployment/env-vars.md) - Required environment variables
- [Monitoring](./deployment/monitoring.md) - Logging, metrics, and alerting

### Operations
- [Troubleshooting](./operations/troubleshooting.md) - Common issues and solutions
- [Performance Tuning](./operations/performance.md) - Optimization guidelines
- [Backup & Recovery](./operations/backup-recovery.md) - Disaster recovery procedures

---

## 📝 Documentation Standards

### Writing Guidelines
- Use clear, concise language
- Include code examples for technical concepts
- Keep documentation up-to-date with code changes
- Use relative links for internal references

### File Organization
```
docs/
├── README.md                 # This file
├── getting-started/          # Onboarding docs
├── architecture/             # System design docs
├── api/                      # API reference
├── development/              # Developer guides
├── deployment/               # Deployment guides
├── operations/               # Operational guides
└── assets/                   # Images, diagrams, etc.
```

### Markdown Style
- Use ATX-style headers (`#`, `##`, `###`)
- Use fenced code blocks with language hints
- Use tables for structured data
- Use admonitions for notes/warnings:
  ```markdown
  > **Note:** Important information
  > 
  > **Warning:** Critical warnings
  ```

---

## 🔄 Updating Documentation

Documentation should be updated in the same PR as code changes. Run the following to validate:

```bash
# Check for broken links
markdown-link-check docs/**/*.md

# Lint markdown
markdownlint docs/**/*.md
```

---

## 📄 License

This documentation is part of the model_proxy_v3 project and is licensed under the same terms.