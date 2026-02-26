---
name: lineage-diff
description: Compare column-level lineage between two versions of a SQL query to show added, removed, and changed data flow edges.
---

# Lineage Diff

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** lineage_check, read, bash (for git operations), glob

Compare column-level lineage between two versions of a SQL model to identify changes in data flow.

## Workflow

1. **Get the original SQL** — Either:
   - Read the file from disk (current committed version)
   - Use `git show HEAD:path/to/file.sql` via `bash` to get the last committed version
   - Accept the "before" SQL directly from the user

2. **Get the modified SQL** — Either:
   - Read the current (modified) file from disk
   - Accept the "after" SQL directly from the user

3. **Run lineage on both versions**:
   - Call `lineage_check` with the original SQL
   - Call `lineage_check` with the modified SQL

4. **Compute the diff**:
   - **Added edges**: Edges in the new lineage that don't exist in the old
   - **Removed edges**: Edges in the old lineage that don't exist in the new
   - **Unchanged edges**: Edges present in both

5. **Report the diff** in a clear format:

```
Lineage Diff: model_name
═══════════════════════════

+ ADDED (new data flow):
  + source_table.new_column → target_table.output_column

- REMOVED (broken data flow):
  - source_table.old_column → target_table.output_column

  UNCHANGED: 5 edges

Impact: 1 new edge, 1 removed edge
```

## Usage

The user invokes this skill with a file path:
- `/lineage-diff models/marts/dim_customers.sql` — Compare current file against last git commit
- `/lineage-diff` — Compare staged changes in the current file

## Edge Matching

Two edges are considered the same if all four fields match:
- `source_table` + `source_column` + `target_table` + `target_column`

The `transform` field is informational and not used for matching.

Use the tools: `lineage_check`, `read`, `bash` (for git operations), `glob`.
