---
name: airflow-hitl
description: Use when the user needs human-in-the-loop workflows in Airflow (approval/reject, form input, or human-driven branching). Covers ApprovalOperator, HITLOperator, HITLBranchOperator, HITLEntryOperator. Requires Airflow 3.1+. Does not cover AI/LLM calls (see airflow-ai).
tags: ["airflow"]
---

# Airflow Human-in-the-Loop Operators

Implement human approval gates, form inputs, and human-driven branching in Airflow DAGs using the HITL operators. These deferrable operators pause workflow execution until a human responds via the Airflow UI or REST API.

## Implementation Checklist

Execute steps in order. Prefer deferrable HITL operators over custom sensors/polling loops.

> **CRITICAL**: Requires Airflow 3.1+. NOT available in Airflow 2.x.
>
> **Deferrable**: All HITL operators are deferrable—they release their worker slot while waiting for human input.
>
> **UI Location**: View pending actions at **Browse → Required Actions** in Airflow UI. Respond via the **task instance page's Required Actions tab** or the REST API.
>
> **Cross-reference**: For AI/LLM calls, see the **airflow-ai** skill.

---

## Step 1: Choose operator

| Operator | Human action | Outcome |
|----------|--------------|---------|
| `ApprovalOperator` | Approve or Reject | Reject causes downstream tasks to be skipped (approval task itself succeeds) |
| `HITLOperator` | Select option(s) + form | Returns selections |
| `HITLBranchOperator` | Select downstream task(s) | Runs selected, skips others |
| `HITLEntryOperator` | Submit form | Returns form data |

---

## Step 2: Implement operator

### ApprovalOperator

```python
from airflow.providers.standard.operators.hitl import ApprovalOperator
from airflow.sdk import dag, task, chain, Param
from pendulum import datetime

@dag(start_date=datetime(2025, 1, 1), schedule="@daily")
def approval_example():
    @task
    def prepare():
        return "Review quarterly report"

    approval = ApprovalOperator(
        task_id="approve_report",
        subject="Report Approval",
        body="{{ ti.xcom_pull(task_ids='prepare') }}",
        defaults="Approve",  # Optional: auto on timeout
        params={"comments": Param("", type="string")},
    )

    @task
    def after_approval(result):
        print(f"Decision: {result['chosen_options']}")

    chain(prepare(), approval)
    after_approval(approval.output)

approval_example()
```

### HITLOperator

> **Required parameters**: `subject` and `options`.

```python
from airflow.providers.standard.operators.hitl import HITLOperator
from airflow.sdk import dag, task, chain, Param
from datetime import timedelta
from pendulum import datetime

@dag(start_date=datetime(2025, 1, 1), schedule="@daily")
def hitl_example():
    hitl = HITLOperator(
        task_id="select_option",
        subject="Select Payment Method",
        body="Choose how to process payment",
        options=["ACH", "Wire", "Check"],  # REQUIRED
        defaults=["ACH"],
        multiple=False,
        execution_timeout=timedelta(hours=4),
        params={"amount": Param(1000, type="number")},
    )

    @task
    def process(result):
        print(f"Selected: {result['chosen_options']}")
        print(f"Amount: {result['params_input']['amount']}")

    process(hitl.output)

hitl_example()
```

### HITLBranchOperator

> **IMPORTANT**: Options can either:
> 1. **Directly match downstream task IDs** - simpler approach
> 2. **Use `options_mapping`** - for human-friendly labels that map to task IDs

```python
from airflow.providers.standard.operators.hitl import HITLBranchOperator
from airflow.sdk import dag, task, chain
from pendulum import datetime

DEPTS = ["marketing", "engineering", "sales"]

@dag(start_date=datetime(2025, 1, 1), schedule="@daily")
def branch_example():
    branch = HITLBranchOperator(
        task_id="select_dept",
        subject="Select Departments",
        options=[f"Fund {d}" for d in DEPTS],
        options_mapping={f"Fund {d}": d for d in DEPTS},
        multiple=True,
    )

    for dept in DEPTS:
        @task(task_id=dept)
        def handle(dept_name: str = dept):
            # Bind the loop variable at definition time to avoid late-binding bugs
            print(f"Processing {dept_name}")
        chain(branch, handle())

branch_example()
```

### HITLEntryOperator

```python
from airflow.providers.standard.operators.hitl import HITLEntryOperator
from airflow.sdk import dag, task, chain, Param
from pendulum import datetime

@dag(start_date=datetime(2025, 1, 1), schedule="@daily")
def entry_example():
    entry = HITLEntryOperator(
        task_id="get_input",
        subject="Enter Details",
        body="Provide response",
        params={
            "response": Param("", type="string"),
            "priority": Param("p3", type="string"),
        },
    )

    @task
    def process(result):
        print(f"Response: {result['params_input']['response']}")

    process(entry.output)

entry_example()
```

---

## Step 3: Optional features

### Notifiers

```python
from airflow.sdk import BaseNotifier, Context
from airflow.providers.standard.operators.hitl import HITLOperator

class MyNotifier(BaseNotifier):
    template_fields = ("message",)
    def __init__(self, message=""): self.message = message
    def notify(self, context: Context):
        if context["ti"].state == "running":
            url = HITLOperator.generate_link_to_ui_from_context(context, base_url="https://airflow.example.com")
            self.log.info(f"Action needed: {url}")

hitl = HITLOperator(..., notifiers=[MyNotifier("{{ task.subject }}")])
```

### Restrict respondents

Format depends on your auth manager:

| Auth Manager | Format | Example |
|--------------|--------|--------|
| SimpleAuthManager | Username | `["admin", "manager"]` |
| FabAuthManager | Email | `["manager@example.com"]` |
| Astro | Astro ID | `["cl1a2b3cd456789ef1gh2ijkl3"]` |

> **Astro Users**: Find Astro ID at **Organization → Access Management**.

```python
hitl = HITLOperator(..., respondents=["manager@example.com"])  # FabAuthManager
```

### Timeout behavior

- **With `defaults`**: Task succeeds, default option(s) selected
- **Without `defaults`**: Task fails on timeout

```python
hitl = HITLOperator(
    ...,
    options=["Option A", "Option B"],
    defaults=["Option A"],  # Auto-selected on timeout
    execution_timeout=timedelta(hours=4),
)
```

### Markdown in body

The `body` parameter supports **markdown formatting** and is **Jinja templatable**:

```python
hitl = HITLOperator(
    ...,
    body="""**Total Budget:** {{ ti.xcom_pull(task_ids='get_budget') }}

| Category | Amount |
|----------|--------|
| Marketing | $1M |
""",
)
```

### Callbacks

All HITL operators support standard Airflow callbacks:

```python
def on_hitl_failure(context):
    print(f"HITL task failed: {context['task_instance'].task_id}")

def on_hitl_success(context):
    print(f"HITL task succeeded with: {context['task_instance'].xcom_pull()}")

hitl = HITLOperator(
    task_id="approval_required",
    subject="Review needed",
    options=["Approve", "Reject"],
    on_failure_callback=on_hitl_failure,
    on_success_callback=on_hitl_success,
)
```

---

## Step 4: API integration

For external responders (Slack, custom app):

```python
import requests, os

HOST = os.getenv("AIRFLOW_HOST")
TOKEN = os.getenv("AIRFLOW_API_TOKEN")

# Get pending actions
r = requests.get(f"{HOST}/api/v2/hitlDetails/?state=pending",
                 headers={"Authorization": f"Bearer {TOKEN}"})

# Respond
requests.patch(
    f"{HOST}/api/v2/hitlDetails/{dag_id}/{run_id}/{task_id}",
    headers={"Authorization": f"Bearer {TOKEN}"},
    json={"chosen_options": ["ACH"], "params_input": {"amount": 1500}}
)
```

---

## Step 5: Safety checks

Before finalizing, verify:

- [ ] Airflow 3.1+ installed
- [ ] For `HITLBranchOperator`: options map to downstream task IDs
- [ ] `defaults` values are in `options` list
- [ ] API token configured if using external responders

---

## Reference

- Airflow HITL Operators: https://airflow.apache.org/docs/apache-airflow-providers-standard/stable/operators/hitl.html

---

## Related Skills

- **airflow-ai**: For AI/LLM task decorators and GenAI patterns
- **authoring-dags**: For general DAG writing best practices
- **testing-dags**: For testing DAGs with debugging cycles
