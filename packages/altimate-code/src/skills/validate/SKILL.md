---
name: validate
description: Run the validation framework against one or more trace IDs, traces in a date range, or all traces in a session
argument-hint: <trace_id(s) | --from <datetime> --to <datetime> | --session-id <id>>
allowed-tools: Bash, Read, Write
---

## Instructions

Run the validation framework using the provided input. The skill supports:
- **Single trace**: `/validate <trace_id>`
- **Multiple traces**: `/validate <id1>,<id2>,<id3>`
- **Date range**: `/validate --from 2026-02-10T00:00:00+00:00 --to 2026-02-15T23:59:59+00:00`
- **Date range with user filter**: `/validate --from <datetime> --to <datetime> --user-id <user_id>`
- **Session ID**: `/validate --session-id <langfuse_session_id>`

---

### Step 1: Determine Input Mode and Run batch_validate.py

**If `$ARGUMENTS` is empty or blank**, read the latest trace ID from the persistent state file before proceeding:

```bash
python3 -c "
import json, pathlib
# Walk up from CWD to find the .claude directory
d = pathlib.Path.cwd()
while d != d.parent:
    candidate = d / '.claude' / 'state' / 'current_trace.json'
    if candidate.exists():
        print(json.loads(candidate.read_text())['trace_id'])
        break
    d = d.parent
"
```

Use the printed trace ID as `$ARGUMENTS` for the rest of this step.

First, resolve the project root directory and the script path:

```bash
# PROJECT_ROOT is the current working directory (the repo root containing .altimate-code/ or .claude/)
PROJECT_ROOT="$(pwd)"
VALIDATE_SCRIPT="$(find "$PROJECT_ROOT/.altimate-code/skills/validate" "$HOME/.altimate-code/skills/validate" "$PROJECT_ROOT/.claude/skills/validate" "$HOME/.claude/skills/validate" -name "batch_validate.py" 2>/dev/null | head -1)"
```

Parse `$ARGUMENTS` to determine the mode and construct the command:
- If it contains `--session-id` → session mode: `uv run --with python-dotenv --with langfuse python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --session-id "<session_id>"`
- If it contains `--from` → date range mode: `uv run --with python-dotenv --with langfuse python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --from-time "<from>" --to-time "<to>"` (add `--user-id` if present)
- If it contains commas (and NOT `--from` or `--session-id`) → multiple trace IDs: `uv run --with python-dotenv --with langfuse python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --trace-ids "$ARGUMENTS"`
- Otherwise → single trace ID: `uv run --with python-dotenv --with langfuse python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --trace-ids "$ARGUMENTS"`

Run the command:

```bash
uv run --with python-dotenv --with langfuse python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" <appropriate_args>
```

The script will:
- Query Langfuse for date range traces (if applicable)
- Call the validation API for each trace
- Write raw JSON results to `logs/batch_validation_<timestamp>.json`
- Create a report folder `logs/batch_validation_<timestamp>/` containing:
  - Individual per-trace markdown reports: `trace_1_<id>.md`, `trace_2_<id>.md`, ...
  - Cross-trace summary: `SUMMARY.md`
- Output JSON to stdout

**IMPORTANT**: The stdout output may be very large. Read the output carefully. The JSON structure is:
```json
{
  "total_traces": N,
  "results": [
    {
      "trace_id": "...",
      "status_code": 200,
      "result": {
        "trace_id": "...",
        "status": "success",
        "error_count": 0,
        "criteria_results": {
          "Groundedness": {"text_response": "...", "input_tokens": ..., "output_tokens": ..., "total_tokens": ..., "model_name": "..."},
          "Validity": {...},
          "Coherence": {...},
          "Utility": {...},
          "Tool Validation": {...}
        },
        "observation_count": N,
        "elapsed_seconds": N
      }
    }
  ],
  "summary": {
    "Groundedness": {"average_score": N, "min_score": N, "max_score": N, ...},
    ...
  },
  "log_file": "logs/batch_validation_...",
  "report_dir": "logs/batch_validation_<timestamp>"
}
```

---

### Step 2: For Each Trace - Semantic Matching (Groundedness Post-Processing)

For EACH trace in the results array, apply semantic matching to Groundedness:

1. Parse the `criteria_results.Groundedness.text_response` and identify all **failed claims** whose `input_transformation_type` is `string_match`.
2. If there are claims identified:
    2.1. **For each claim , check whether `claim_text` and `source_data` are semantically the same.
        - 2 statements are considered **semantically same** if they talk about the same topics.
        - 2 statements are considered **semantically different** if they talk about different topics.
        - If semantically same → update claim status to `SUCCESS`.
    2.2. Re-count the number of failing claims whose status is `FAILURE`.
    2.3. Update `failed_count` with the re-counted number.
    2.4. Re-calculate OverallScore as `round(((total length of claims - failed_count)/total length of claims) * 5, 2)`
3. If no claims identified, do nothing.

**This is being done for semantic matching as the deterministic tool did not do semantic matching.**

When doing this task, first generate a sequence of steps as a plan and execute step by step for consistency.

---

### Step 3: For Each Trace - Semantic Reason Generation (Groundedness Post-Processing)

For EACH trace in the results array, apply semantic reason generation to Groundedness:

1. Parse the `criteria_results.Groundedness.text_response` and identify all **claims**.
2. If there are claims identified, then **for each claim**:
    2.1. If claim status is `SUCCESS` → generate a brief and complete reason explaining **why it succeeded** (e.g. the claim matches the source data, the value is within acceptable error, etc.) and update the claim's `reason` field with the generated reason.
        - REMEMBER to provide full proof details in the reason with tool calculated claims as well as actual claim.
    2.2. If claim status is `FAILURE` → generate a brief and complete reason explaining **why it failed** (e.g. the claimed value differs from source data, the error exceeds the threshold, etc.) and update the claim's `reason` field with the generated reason.
        - REMEMBER to provide full proof details in the reason with tool calculated claims as well as actual claim.
3. If no claims identified, do nothing.

**This ensures every claim has a human-readable, semantically generated reason regardless of its outcome.**

When doing this task, first generate a sequence of steps as a plan and execute step by step for consistency.

---

### Step 4: Present Per-Trace Results

For EACH trace, present the results in the following format:

---

## Trace: `<trace_id>`

### Criteria Summary Table in markdown table

| Criteria | Status | Score |
|---|---|---|
| **Groundedness** | <status> | <score>/5 |
| **Validity** | <status> | <score>/5 |
| **Coherence** | <status> | <score>/5 |
| **Utility** | <status> | <score>/5 |
| **Tool Validation** | <status> | <score>/5 |

P.S. **Consider 'RIGHT NODE' as 'SUCCESS' and 'WRONG NODE' as 'FAILURE' IF PRESENT.**

### Per-Criteria Node Results in markdown table

For **Validity**, **Coherence**, and **Utility**, show a node-level breakdown table:

| Node | Score | Status |
|---|---|---|
| <node_name> | <score> | <status> |

### Individual Criteria Results

#### Groundedness

Generate a summary of the generated groundedness response detailing strengths and weaknesses.

Now display **ALL the claims in the **markdown table format** with these columns**:

| # | Source Tool | Source Data| Input Data                                | Claim Text                               | Claimed                      | Input | Conversion Statement | Calculated | Error | Status | Reason |
|---|---|-----------------------|-------------------------------------------|------------------------------------------|------------------------------|---|---|---|---|---|---|
| <claim_id> | <source tool id> | <claim_text>          | <source_data>| <input_data>| <claimed_value> <claim_unit> | <input data> | <input to claim conversion statement> | <Calculated claim> <claim_unit> | <Error in claim as %> | SUCCESS/FAILURE | <reason> |

Then show a separate **Failed Claims Summary in markdown table format** with only the failed claims:

| # | Claim | Claimed | Source Tool ID   | Actual Text   | Actual Data  | Error | Root Cause  |
|---|---|---|------------------|---------------|--------------|---|-------------|
| <claim_id> | <claim_text> | <claimed_value> | <source_tool_id> | <source_data> | <Input data> | <error %> | <reasoning> |

REMEMBER to generate each value COMPLETELY. DO NOT TRUNCATE.

#### Validity
Generate a summary of the generated validity response detailing strengths and weaknesses.

#### Coherence
Generate a summary of the generated coherence response detailing strengths and weaknesses.

#### Utility
Generate a summary of the generated utility response detailing strengths and weaknesses.

#### Tool Validation
Generate a summary of the generated tool validation response detailing strengths and weaknesses.

Now display all the tool details in markdown table format:

| # | Tool Name | Tool Status |
|---|---|---|
| <id> | <tool name> | <tool status> |

REMEMBER to generate each value completely. NO TRUNCATION.

After presenting each trace result, write it to a markdown file inside the report directory. Read `report_dir` from the batch_validate.py JSON output. Use the trace index (1-based) and first 12 characters of the trace ID for the filename:

```bash
cat > "<report_dir>/trace_<N>_<first_12_chars_of_id>.md" <<'TRACE_EOF'
<full per-trace result output from above>
TRACE_EOF
```

---

### Step 5: Cross-Trace Comprehensive Summary (for all evaluations)

After presenting all individual trace results, generate a comprehensive summary:

#### Overall Score Summary in markdown table format

| Criteria | Average Score | Min | Max | Traces Evaluated |
|---|---|---|---|---|
| **Groundedness** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Validity** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Coherence** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Utility** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Tool Validation** | <avg>/5 | <min>/5 | <max>/5 | <count> |

Use the scores AFTER semantic matching corrections from Step 2, and reasons AFTER semantic reason generation from Step 3.

#### Per-Trace Score Breakdown in markdown table format

| Trace ID | Groundedness | Validity | Coherence | Utility | Tool Validation |
|---|---|---|---|---|---|
| <id> | <score>/5 | <score>/5 | <score>/5 | <score>/5 | <score>/5 |

#### Category-Wise Analysis

For EACH category, provide:
- **Common Strengths**: Patterns of success observed across traces
- **Common Weaknesses**: Recurring issues found across traces
- **Recommendations**: Actionable improvements based on the analysis

After generating the overall summary, write it to `SUMMARY.md` inside the report directory:

```bash
cat > "<report_dir>/SUMMARY.md" <<'SUMMARY_MD_EOF'
<full cross-trace summary output from above>
SUMMARY_MD_EOF
```

---

### Step 6: Log Summary to File

Append the comprehensive summary (with semantic matching corrections and semantic reasons) to the log file. Read the `log_file` path from the batch_validate.py output and append:

```bash
cat >> <log_file_path> <<'SUMMARY_EOF'

=== COMPREHENSIVE SUMMARY (with semantic matching corrections and semantic reasons) ===
<paste the cross-trace summary and per-trace corrected scores here>
SUMMARY_EOF
```

This ensures the log file contains both the raw API results and the post-processed summary with semantic matching corrections and semantic reasons.