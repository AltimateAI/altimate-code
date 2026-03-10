#!/bin/bash
# Hook: UserPromptSubmit - Suggest Airflow skills when relevant keywords detected
# Routes to specific skills based on context, with the general airflow skill as fallback

# Read user prompt from stdin
USER_PROMPT=$(cat)

PROMPT_LOWER=$(echo "$USER_PROMPT" | tr '[:upper:]' '[:lower:]')

# Check if user already explicitly mentioned using a skill
if echo "$PROMPT_LOWER" | grep -q "use.*skill\|/data:"; then
    exit 0
fi

# --- Route 1: Deploy keywords -> deploying-airflow skill ---
DEPLOY_KEYWORDS=(
    "astro deploy"
    "deploy.*dag"
    "deploy.*airflow"
    "deploy.*pipeline"
    "dag-only deploy"
    "dags-only deploy"
    "airflow.*ci/cd"
    "airflow.*ci cd"
)

for keyword in "${DEPLOY_KEYWORDS[@]}"; do
    if echo "$PROMPT_LOWER" | grep -qE "$keyword"; then
        cat <<'EOF'
Deployment request detected.

IMPORTANT: Use the `/data:deploying-airflow` skill for deployment operations. This skill covers:
- Astro deploy commands (full, DAG-only, image-only, dbt)
- CI/CD setup and GitHub integration
- Open-source deployment (Docker Compose, Kubernetes Helm chart)

Load the skill: `/data:deploying-airflow`

Then proceed with the user's request.
EOF
        exit 0
    fi
done

# --- Route 2: Local dev / setup keywords -> managing-astro-local-env ---
LOCAL_KEYWORDS=(
    "run airflow locally"
    "run airflow local"
    "local airflow"
    "start airflow"
    "install airflow"
    "set up airflow"
    "setup airflow"
    "astro dev start"
    "astro dev init"
    "astro dev"
    "airflow local"
)

for keyword in "${LOCAL_KEYWORDS[@]}"; do
    if echo "$PROMPT_LOWER" | grep -qE "$keyword"; then
        cat <<'EOF'
Local Airflow environment request detected.

IMPORTANT: Use the `/data:managing-astro-local-env` skill for local environment management. The Astro CLI is the recommended way to run Airflow locally:
- `astro dev init` to initialize a project
- `astro dev start` to start a local Airflow environment
- `astro dev parse` to validate DAGs
- `astro dev pytest` to run tests

Load the skill: `/data:managing-astro-local-env`

Then proceed with the user's request.
EOF
        exit 0
    fi
done

# --- Route 3: General Airflow keywords -> airflow skill ---
AIRFLOW_KEYWORDS=(
    "airflow"
    "dag"
    "dags"
    "airflow.*pipeline"
    "airflow.*workflow"
    "task instance"
    "task run"
    "airflow.*connection"
    "airflow.*variable"
    "airflow.*pool"
    "trigger dag"
    "test dag"
    "debug dag"
    "dag fail"
    "list dags"
    "show dags"
    "get dag"
    "dag status"
    "dag run"
    "af "
)

MATCHED=false
for keyword in "${AIRFLOW_KEYWORDS[@]}"; do
    if echo "$PROMPT_LOWER" | grep -q "$keyword"; then
        MATCHED=true
        break
    fi
done

if [ "$MATCHED" = true ]; then
    cat <<'EOF'
Airflow operation detected.

IMPORTANT: Use the `/data:airflow` skill for Airflow operations. This skill provides:
- Structured workflow guidance
- Best practices for MCP tool usage
- Routing to specialized skills (testing, debugging, authoring, deploying)
- Prevention of bash/CLI antipatterns

Load the skill first: `/data:airflow`

Then proceed with the user's request.
EOF
    exit 0
fi

# No keywords found, pass through
exit 0
