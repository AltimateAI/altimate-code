# Deploying Team Training

Get every teammate's AI automatically applying the same SQL conventions, naming standards, and anti-pattern rules. Achieved by committing `.altimate-code/memory/` to git so that teammates inherit your training on `git pull`.

---

## Step 1: Create Your First Team Training Entries

Use the `/teach` or `/train` skills to save project-specific conventions:

```
/teach always use QUALIFY instead of nested window function subqueries in Snowflake SQL
```

```
/teach our staging models follow the pattern: stg_<source>__<entity>.sql
```

Verify the training was saved:

```bash
/training-status
```

This shows all active training entries, their scope (global vs project), and when they were added.

---

## Step 2: Locate the Training Files

Training is stored in `.altimate-code/memory/` in your project root. Each entry is a markdown file with YAML frontmatter:

```
.altimate-code/
  memory/
    sql-conventions.md
    naming-standards.md
    project-patterns.md
```

**Global vs. project scope:**
- **Project scope** (`.altimate-code/memory/`): Applies when working in this project. Commit to git to share with team.
- **Global scope** (`~/.altimate-code/memory/`): Applies across all projects. Do not commit, as this is personal.

---

## Step 3: Commit to Git

```bash
git add .altimate-code/memory/
git commit -m "Add team SQL conventions and naming standards"
git push
```

Teammates who `git pull` automatically inherit all training entries. No additional setup is required because the tool reads from `.altimate-code/memory/` on startup.

---

## Step 4: Verify a Teammate Got the Training

After a teammate pulls, they can run:

```bash
/training-status
```

They should see the same entries you created. If they don't, check that `.altimate-code/memory/` is not in `.gitignore`.

---

## Best Practices

**What to teach first:**
1. Your team's most common SQL mistakes (the things that keep coming up in code review)
2. Naming conventions for models, tables, and columns
3. Project-specific patterns: your medallion layer names, your warehouse, your dbt project structure

**Handling conflicting corrections:**
Later corrections override earlier ones for the same topic. Use `/training-status` to audit and delete stale entries with `/forget <entry-id>`.

**Global vs. project scope:**
Use project scope for team standards. Use global scope only for personal preferences that apply to all your projects (e.g., preferred SQL style).

---

## Limitations

Training is as good as the corrections you save. The system doesn't infer conventions from your existing codebase; you teach it explicitly. For the full description of how training works, see [Training Overview](index.md).
