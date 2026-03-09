# Implementation Plan: Verify Restructured Branch Completeness

## Summary

The draft plan is fundamentally sound. I've verified:

- ✅ All 68 custom tools moved to `src/altimate/tools/`
- ✅ All 3 bridge files moved to `src/altimate/bridge/`
- ✅ All 5 prompt files moved to `src/altimate/prompts/`
- ✅ Python engine (71 files) preserved
- ✅ Docs, CI/CD, skills present
- ✅ Merge tooling added in `script/upstream/`

**Key findings requiring adjustment:**

1. Additional Altimate files exist on restructure/main not in draft: `cli/`, `plugin/`, `command/`, `session/`
2. Need to verify `altimate_change` marker blocks capture original modifications
3. Session feature was added during restructure (not in prep/revert-at-main)

---

## Files to Create

### 1. `script/verify-restructure/verify.ts`

Main verification script.

---

## Step-by-step Approach

### Step 1: Create Verification Script

Create `script/verify-restructure/verify.ts` that:

```typescript
#!/usr/bin/env bun

const OLD_BRANCH = "prep/revert-at-main"
const NEW_BRANCH = "restructure/main"
const BASE_BRANCH = "v1.2.18"

const pathMap = [
  // Tools
  {
    from: /^packages\/opencode\/src\/tool\/altimate-core-(.+)\.ts$/,
    to: "packages/opencode/src/altimate/tools/altimate-core-$1.ts",
  },
  {
    from: /^packages\/opencode\/src\/tool\/(sql|warehouse|schema|finops|dbt|lineage|project)-(.+)\.ts$/,
    to: "packages/opencode/src/altimate/tools/$1-$2.ts",
  },
  // Bridge
  { from: /^packages\/opencode\/src\/bridge\/(.+)$/, to: "packages/opencode/src/altimate/bridge/$1" },
  // Prompts
  {
    from: /^packages\/opencode\/src\/agent\/prompt\/(analyst|builder|executive|migrator|validator)\.txt$/,
    to: "packages/opencode/src/altimate/prompts/$1.txt",
  },
  // Other altimate files
  { from: /^packages\/opencode\/src\/altimate\/cli\/(.+)$/, to: "packages/opencode/src/altimate/cli/$1" },
  { from: /^packages\/opencode\/src\/altimate\/plugin\/(.+)$/, to: "packages/opencode/src/altimate/plugin/$1" },
  { from: /^packages\/opencode\/src\/altimate\/index\.ts$/, to: "packages/opencode/src/altimate/index.ts" },
  // Python engine (unchanged)
  { from: /^packages\/altimate-engine\/(.+)$/, to: "packages/altimate-engine/$1" },
  // Everything else (docs, CI/CD, skills, etc.)
  { from: /^(.+)$/, to: "$1" },
]
```

### Step 2: Run Tool Category Verification

Execute file-by-file comparison:

- Extract custom files from `prep/revert-at-main` (not in v1.2.18)
- Map each to restructure/main path
- Compare and categorize: MATCH / MOVED / MODIFIED / MISSING

### Step 3: Run Python Engine Verification

```bash
diff -rq <(git show prep/revert-at-main:packages/altimate-engine/) \
        <(git show restructure/main:packages/altimate-engine/)
```

### Step 4: Verify altimate_change Blocks

For each file modified with markers on restructure/main:

- Extract content between `// altimate_change start` and `// altimate_change end`
- Compare against equivalent modification on prep/revert-at-main

### Step 5: Build & Test

```bash
cd packages/opencode && bun run build
cd packages/opencode && bun test
```

---

## Key Decisions

### 1. Why path mapping instead of content hashing?

Files may have internal reference changes. Content comparison ensures functional equivalence, not just filename matching.

### 2. Why not use git rename detection?

As noted in draft, rename detection is unreliable with 4000+ files. Explicit path mapping is deterministic.

### 3. Why verify `altimate_change` blocks separately?

These are critical modifications to upstream code. Need to ensure markers capture the exact original changes.

---

## Edge Cases

### 1. New files on restructure/main (not in prep/revert-at-main)

**Scenario:** Files added during restructure that weren't in old main (e.g., merge tooling)
**Handling:** These are expected additions, mark as "NEW" and verify they're intentional

### 2. Session feature discrepancy

**Scenario:** `src/altimate/session/PAID_CONTEXT_FEATURES.md` exists on restructure/main but not prep/revert-at-main
**Handling:** Verify it's new functionality added during restructure, not a loss

### 3. Binary files in docs

**Scenario:** PNG files in docs/
**Handling:** Use binary diff, report if content differs

### 4. Large diffs in modified files

**Handling:** Show first 50 lines of diff, offer to show full with flag

---

## Verification Checklist

| Category               | Count (old) | Count (new) | Status |
| ---------------------- | ----------- | ----------- | ------ |
| altimate-core-\* tools | 33          | 33          | ⏳     |
| sql-\* tools           | 10          | 10          | ⏳     |
| warehouse-\* tools     | 5           | 5           | ⏳     |
| schema-\* tools        | 6           | 6           | ⏳     |
| finops-\* tools        | 6           | 6           | ⏳     |
| dbt-\* tools           | 4           | 4           | ⏳     |
| lineage-\* tools       | 1           | 1           | ⏳     |
| project-scan           | 1           | 1           | ⏳     |
| Bridge                 | 3           | 3           | ⏳     |
| Prompts                | 5           | 5           | ⏳     |
| Telemetry              | 1           | 1           | ⏳     |
| CLI/Plugin/Other       | ?           | 7           | ⏳     |
| Python engine          | 71          | 71          | ⏳     |
| Docs                   | ?           | ?           | ⏳     |
| Skills                 | 11          | 11          | ⏳     |
| CI/CD workflows        | ?           | ?           | ⏳     |

---

## Command to Run

```bash
# Create verification script
mkdir -p script/verify-restructure

# Run verification (after script created)
bun run script/verify-restructure/verify.ts
```
