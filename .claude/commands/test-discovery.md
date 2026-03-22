---
description: Discover and write missing tests for altimate-code. Runs hourly to find real-world gaps. Uses a team with a critic to validate tests before committing.
---

# Test Discovery & Generation

You are a test engineer for `altimate-code`, a data engineering AI agent built as a fork of OpenCode. Your job is to find missing tests that would catch real bugs — not write tests for the sake of coverage.

## Phase 1: Reconnaissance (15 min)

### 1.1 Understand what changed recently

```bash
# Recent commits (last 7 days)
git log --oneline --since="7 days ago" --no-merges | head -20

# Files changed recently
git diff HEAD~10..HEAD --stat | tail -20

# Any recent CI failures
gh run list --repo AltimateAI/altimate-code --limit 10 --json conclusion,name,headBranch --jq '.[] | select(.conclusion == "failure") | "\(.name): \(.headBranch)"'
```

### 1.2 Find untested code paths

```bash
# Files with no corresponding test
for f in $(find packages/opencode/src -name "*.ts" -not -path "*/tui/*" | head -40); do
  base=$(basename "$f" .ts)
  dir=$(basename $(dirname "$f"))
  if ! find packages/opencode/test -name "${base}*test*" 2>/dev/null | grep -q .; then
    echo "UNTESTED: $f"
  fi
done

# Functions exported but never tested
grep -rn "export function\|export async function\|export const.*=" packages/opencode/src/cli/cmd/skill-helpers.ts packages/opencode/src/skill/skill.ts | head -20
```

### 1.3 Read the docs to understand user-facing features

Read these files to understand what users expect to work:
- `docs/docs/configure/skills.md`
- `docs/docs/configure/tools/custom.md`
- `docs/docs/configure/warehouses.md`
- `docs/docs/configure/mcp-servers.md`
- `docs/docs/data-engineering/tools/index.md`

### 1.4 Research real-world usage

Search online for how people actually use altimate-code and similar tools:
- Search: "altimate-code" OR "altimate code" site:github.com
- Search: "opencode skills" OR "opencode plugin" issues bugs
- Search: "claude code skills" edge cases problems
- Search: "dbt agent" OR "data engineering AI agent" common failures

Look for:
- Bug reports or issues that reveal untested paths
- Usage patterns we haven't considered
- Edge cases from real projects (monorepos, CI/CD, Docker, Windows WSL)
- Integration scenarios (dbt + warehouse + skills together)

## Phase 2: Identify Test Candidates (10 min)

Based on reconnaissance, identify 2-4 test candidates. For each, write a brief case:

```
CANDIDATE: [descriptive name]
FILE: [which source file is being tested]
RISK: [what could go wrong if untested — a real scenario, not hypothetical]
TYPE: [unit | integration | e2e | adversarial | regression]
PRIORITY: [P0 = blocks users, P1 = causes confusion, P2 = edge case]
```

**Rules for candidate selection:**

- NEVER write tests for code that's already well-tested (check existing tests first)
- NEVER write trivial tests (testing that a constant equals itself)
- NEVER duplicate tests that already exist in a different file
- Focus on code paths where a real user or real input would trigger a bug
- Prefer tests that encode behavior discovered during bug fixes
- Integration tests > unit tests for things that cross module boundaries
- Each run should target a DIFFERENT area — rotate through:
  - Session: skill loading, tool detection, PATH injection
  - Week 1: skills + tools
  - Week 2: warehouse connections + schema
  - Week 3: dbt integration + finops
  - Week 4: config, permissions, MCP
  - Repeat

**To decide which area to target this run:**
```bash
# Check which test directories were modified most recently
ls -lt packages/opencode/test/*/  | head -20

# Pick the LEAST recently modified area that has source code changes
```

## Phase 3: Team Review (10 min)

Create a team with a critic agent to validate test quality before committing.

```
TeamCreate: test-review
```

Spawn a **critic** agent:

```
Agent:
  name: "test-critic"
  team_name: "test-review"
  subagent_type: "general-purpose"
  model: "sonnet"
  prompt: |
    You are a test critic. You will receive proposed test cases. For each test, evaluate:

    1. IS IT REAL? Would this test catch a bug that actually affects users?
       - Reject tests for hypothetical scenarios that can't happen
       - Reject tests that duplicate existing coverage
       - Reject tests for code that's trivially correct

    2. IS IT CORRECT? Does the test actually test what it claims?
       - Check assertions match the described behavior
       - Check edge cases are truly edges, not normal paths
       - Check that mocks don't hide real bugs

    3. IS IT PLACED RIGHT? Is the test in the right file/directory?
       - Check it matches the existing test structure
       - Check the file name follows conventions
       - New test files must NOT be named the same as existing ones

    4. WILL IT STAY GREEN? Will this test be flaky?
       - Reject tests that depend on network, timing, or external state
       - Reject tests that depend on specific file system layout
       - tmpdir() from fixture.ts is fine

    Respond with:
    - APPROVE: [test name] — [one line reason]
    - REJECT: [test name] — [one line reason]
    - REVISE: [test name] — [specific change needed]

    Be harsh. It's better to ship 1 excellent test than 4 mediocre ones.
```

Send the critic your test candidates with full code. Wait for their response. Only proceed with APPROVED tests.

## Phase 4: Write & Verify (10 min)

### File placement rules

```
packages/opencode/test/
├── cli/              # CLI command tests (skill.test.ts, etc.)
├── config/           # Config parsing, validation
├── skill/            # Skill loading, discovery
├── tool/             # Tool execution, bash, truncation
├── session/          # Session management, prompt, compaction
├── server/           # HTTP API endpoints
├── mcp/              # MCP server integration
├── altimate/         # Data engineering tools (SQL, schema, finops, dbt)
├── provider/         # LLM provider tests
├── memory/           # Memory/training system
├── permission/       # Permission evaluation
├── project/          # Project detection, worktree
├── install/          # Installation, bin wrapper
└── util/             # Utility functions
```

**File naming:**
- `{feature}.test.ts` for new test files
- Add to existing file if the feature already has tests
- NEVER create a file that already exists

**Test template:**
```typescript
import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
// ... imports from source

describe("[Feature]: [behavior being tested]", () => {
  test("[specific scenario]", async () => {
    // Arrange
    // Act
    // Assert
  })
})
```

### Write the tests

For each APPROVED test:
1. Check the target test file doesn't already exist with different content
2. Write the test
3. Run it: `bun test test/path/to/file.test.ts`
4. If it fails, determine if it's a real bug (report it) or a test issue (fix the test)
5. If all tests pass, proceed to commit

### Run marker check

```bash
bun run script/upstream/analyze.ts --markers --base main --strict
```

## Phase 5: Commit (5 min)

```bash
git checkout -b test/hourly-$(date +%Y%m%d-%H%M)
git add packages/opencode/test/
# NEVER add source changes — tests only
git commit -m "test: [area] — [what's being tested]

[1-2 sentence description of what risk these tests mitigate]

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"

git push -u origin HEAD
gh pr create --title "test: [area] — [what's being tested]" --body "$(cat <<'EOF'
### What does this PR do?
Adds tests for [area] discovered by hourly test sweep.

### Type of change
- [x] New feature (non-breaking change which adds functionality)

### Issue for this PR
N/A — proactive test coverage

### How did you verify your code works?
`bun test test/[path]` — all pass

### Checklist
- [x] I have added tests that prove my fix is effective or that my feature works
- [x] New and existing unit tests pass locally with my changes
EOF
)"
```

Send `shutdown_request` to the critic. Delete the team.

## Rules

1. **Each run is independent.** Don't look at the same files as the last run. Rotate areas.
2. **Real scenarios only.** Every test must have a plausible "a user did X and it broke" story.
3. **Don't over-test.** 1-3 well-placed tests per run is ideal. Zero is fine if nothing needs testing.
4. **Never modify source code.** This command only writes tests. If you find a bug, create a GitHub issue.
5. **Use tmpdir().** All filesystem tests use `await using tmp = await tmpdir({ git: true })`.
6. **Critic must approve.** Don't commit tests the critic rejected.
7. **Check existing tests first.** Run `grep -r "describe.*[feature]" packages/opencode/test/` before writing.
8. **Branch protection.** Always use a feature branch + PR. Never push to main.
