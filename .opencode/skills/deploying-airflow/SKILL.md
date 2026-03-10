---
name: deploying-airflow
description: Deploy Airflow DAGs and projects. Use when the user wants to deploy code, push DAGs, set up CI/CD, deploy to production, or asks about deployment strategies for Airflow.
tags: ["airflow"]
---

# Deploying Airflow

This skill covers deploying Airflow DAGs and projects to production, whether using Astro (Astronomer's managed platform) or open-source Airflow on Docker Compose or Kubernetes.

**Choosing a path:** Astro is a good fit for managed operations and faster CI/CD. For open-source, use Docker Compose for dev and the Helm chart for production.

---

## Astro (Astronomer)

Astro provides CLI commands and GitHub integration for deploying Airflow projects.

### Deploy Commands

| Command | What It Does |
|---------|--------------|
| `astro deploy` | Full project deploy — builds Docker image and deploys DAGs |
| `astro deploy --dags` | DAG-only deploy — pushes only DAG files (fast, no image build) |
| `astro deploy --image` | Image-only deploy — pushes only the Docker image (for multi-repo CI/CD) |
| `astro deploy --dbt` | dbt project deploy — deploys a dbt project to run alongside Airflow |

### Full Project Deploy

Builds a Docker image from your Astro project and deploys everything (DAGs, plugins, requirements, packages):

```bash
astro deploy
```

Use this when you've changed `requirements.txt`, `Dockerfile`, `packages.txt`, plugins, or any non-DAG file.

### DAG-Only Deploy

Pushes only files in the `dags/` directory without rebuilding the Docker image:

```bash
astro deploy --dags
```

This is significantly faster than a full deploy since it skips the image build. Use this when you've only changed DAG files and haven't modified dependencies or configuration.

### Image-Only Deploy

Pushes only the Docker image without updating DAGs:

```bash
astro deploy --image
```

This is useful in multi-repo setups where DAGs are deployed separately from the image, or in CI/CD pipelines that manage image and DAG deploys independently.

### dbt Project Deploy

Deploys a dbt project to run with Cosmos on an Astro deployment:

```bash
astro deploy --dbt
```

### GitHub Integration

Astro supports branch-to-deployment mapping for automated deploys:

- Map branches to specific deployments (e.g., `main` -> production, `develop` -> staging)
- Pushes to mapped branches trigger automatic deploys
- Supports DAG-only deploys on merge for faster iteration

Configure this in the Astro UI under **Deployment Settings > CI/CD**.

### CI/CD Patterns

Common CI/CD strategies on Astro:

1. **DAG-only on feature branches**: Use `astro deploy --dags` for fast iteration during development
2. **Full deploy on main**: Use `astro deploy` on merge to main for production releases
3. **Separate image and DAG pipelines**: Use `--image` and `--dags` in separate CI jobs for independent release cycles

### Deploy Queue

When multiple deploys are triggered in quick succession, Astro processes them sequentially in a deploy queue. Each deploy completes before the next one starts.

### Reference

- [Astro Deploy Documentation](https://www.astronomer.io/docs/astro/deploy-code)

---

## Open-Source: Docker Compose

Deploy Airflow using the official Docker Compose setup. This is recommended for learning and exploration — for production, use Kubernetes with the Helm chart (see below).

### Prerequisites

- Docker and Docker Compose v2.14.0+
- The official `apache/airflow` Docker image

### Quick Start

Download the official Airflow 3 Docker Compose file:

```bash
curl -LfO 'https://airflow.apache.org/docs/apache-airflow/stable/docker-compose.yaml'
```

This sets up the full Airflow 3 architecture:

| Service | Purpose |
|---------|---------|
| `airflow-apiserver` | REST API and UI (port 8080) |
| `airflow-scheduler` | Schedules DAG runs |
| `airflow-dag-processor` | Parses and processes DAG files |
| `airflow-worker` | Executes tasks (CeleryExecutor) |
| `airflow-triggerer` | Handles deferrable/async tasks |
| `postgres` | Metadata database |
| `redis` | Celery message broker |

### Minimal Setup

For a simpler setup with LocalExecutor (no Celery/Redis), create a `docker-compose.yaml`:

```yaml
x-airflow-common: &airflow-common
  image: apache/airflow:3  # Use the latest Airflow 3.x release
  environment: &airflow-common-env
    AIRFLOW__CORE__EXECUTOR: LocalExecutor
    AIRFLOW__DATABASE__SQL_ALCHEMY_CONN: postgresql+psycopg2://airflow:airflow@postgres/airflow
    AIRFLOW__CORE__LOAD_EXAMPLES: 'false'
    AIRFLOW__CORE__DAGS_FOLDER: /opt/airflow/dags
  volumes:
    - ./dags:/opt/airflow/dags
    - ./logs:/opt/airflow/logs
    - ./plugins:/opt/airflow/plugins
  depends_on:
    postgres:
      condition: service_healthy

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: airflow
      POSTGRES_PASSWORD: airflow
      POSTGRES_DB: airflow
    volumes:
      - postgres-db-volume:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "airflow"]
      interval: 10s
      retries: 5
      start_period: 5s

  airflow-init:
    <<: *airflow-common
    entrypoint: /bin/bash
    command:
      - -c
      - |
        airflow db migrate
        airflow users create \
          --username admin \
          --firstname Admin \
          --lastname User \
          --role Admin \
          --email admin@example.com \
          --password admin
    depends_on:
      postgres:
        condition: service_healthy

  airflow-apiserver:
    <<: *airflow-common
    command: airflow api-server
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "curl", "--fail", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s

  airflow-scheduler:
    <<: *airflow-common
    command: airflow scheduler

  airflow-dag-processor:
    <<: *airflow-common
    command: airflow dag-processor

  airflow-triggerer:
    <<: *airflow-common
    command: airflow triggerer

volumes:
  postgres-db-volume:
```

> **Airflow 3 architecture note**: The webserver has been replaced by the **API server** (`airflow api-server`), and the **DAG processor** now runs as a standalone process separate from the scheduler.

### Common Operations

```bash
# Start all services
docker compose up -d

# Stop all services
docker compose down

# View logs
docker compose logs -f airflow-scheduler

# Restart after requirements change
docker compose down && docker compose up -d --build

# Run a one-off Airflow CLI command
docker compose exec airflow-apiserver airflow dags list
```

### Installing Python Packages

Add packages to `requirements.txt` and rebuild:

```bash
# Add to requirements.txt, then:
docker compose down
docker compose up -d --build
```

Or use a custom Dockerfile:

```dockerfile
FROM apache/airflow:3  # Pin to a specific version (e.g., 3.1.7) for reproducibility
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
```

Update `docker-compose.yaml` to build from the Dockerfile:

```yaml
x-airflow-common: &airflow-common
  build:
    context: .
    dockerfile: Dockerfile
  # ... rest of config
```

### Environment Variables

Configure Airflow settings via environment variables in `docker-compose.yaml`:

```yaml
environment:
  # Core settings
  AIRFLOW__CORE__EXECUTOR: LocalExecutor
  AIRFLOW__CORE__PARALLELISM: 32
  AIRFLOW__CORE__MAX_ACTIVE_TASKS_PER_DAG: 16

  # Email
  AIRFLOW__EMAIL__EMAIL_BACKEND: airflow.utils.email.send_email_smtp
  AIRFLOW__SMTP__SMTP_HOST: smtp.example.com

  # Connections (as URI)
  AIRFLOW_CONN_MY_DB: postgresql://user:pass@host:5432/db
```

---

## Open-Source: Kubernetes (Helm Chart)

Deploy Airflow on Kubernetes using the official Apache Airflow Helm chart.

### Prerequisites

- A Kubernetes cluster
- `kubectl` configured
- `helm` installed

### Installation

```bash
# Add the Airflow Helm repo
helm repo add apache-airflow https://airflow.apache.org
helm repo update

# Install with default values
helm install airflow apache-airflow/airflow \
  --namespace airflow \
  --create-namespace

# Install with custom values
helm install airflow apache-airflow/airflow \
  --namespace airflow \
  --create-namespace \
  -f values.yaml
```

### Key values.yaml Configuration

```yaml
# Executor type
executor: KubernetesExecutor  # or CeleryExecutor, LocalExecutor

# Airflow image (pin to your desired version)
defaultAirflowRepository: apache/airflow
defaultAirflowTag: "3"  # Or pin: "3.1.7"

# Git-sync for DAGs (recommended for production)
dags:
  gitSync:
    enabled: true
    repo: https://github.com/your-org/your-dags.git
    branch: main
    subPath: dags
    wait: 60  # seconds between syncs

# API server (replaces webserver in Airflow 3)
apiServer:
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "500m"
      memory: "1Gi"
  replicas: 1

# Scheduler
scheduler:
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "1000m"
      memory: "2Gi"

# Standalone DAG processor
dagProcessor:
  enabled: true
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "500m"
      memory: "1Gi"

# Triggerer (for deferrable tasks)
triggerer:
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "500m"
      memory: "1Gi"

# Worker resources (CeleryExecutor only)
workers:
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2000m"
      memory: "4Gi"
  replicas: 2

# Log persistence
logs:
  persistence:
    enabled: true
    size: 10Gi

# PostgreSQL (built-in)
postgresql:
  enabled: true

# Or use an external database
# postgresql:
#   enabled: false
# data:
#   metadataConnection:
#     user: airflow
#     pass: airflow
#     host: your-rds-host.amazonaws.com
#     port: 5432
#     db: airflow
```

### Upgrading

```bash
# Upgrade with new values
helm upgrade airflow apache-airflow/airflow \
  --namespace airflow \
  -f values.yaml

# Upgrade to a new Airflow version
helm upgrade airflow apache-airflow/airflow \
  --namespace airflow \
  --set defaultAirflowTag="<version>"
```

### DAG Deployment Strategies on Kubernetes

1. **Git-sync** (recommended): DAGs are synced from a Git repository automatically
2. **Persistent Volume**: Mount a shared PV containing DAGs
3. **Baked into image**: Include DAGs in a custom Docker image

### Useful Commands

```bash
# Check pod status
kubectl get pods -n airflow

# View scheduler logs
kubectl logs -f deployment/airflow-scheduler -n airflow

# Port-forward the API server
kubectl port-forward svc/airflow-apiserver 8080:8080 -n airflow

# Run a one-off CLI command
kubectl exec -it deployment/airflow-scheduler -n airflow -- airflow dags list
```

---

## Related Skills

- **setting-up-astro-project**: For initializing a new Astro project
- **managing-astro-local-env**: For local development with `astro dev`
- **authoring-dags**: For writing DAGs before deployment
- **testing-dags**: For testing DAGs before deployment
