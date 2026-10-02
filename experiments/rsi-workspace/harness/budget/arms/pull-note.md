# What the model sees in the `pull` arm

Frontmatter has `name` and `description` only: no `applyPaths`, no `alwaysApply`.

Source checks (packages/opencode/src/):
- `skill/index.ts` (~line 59-62, 197): `alwaysApply`/`applyPaths` are optional and carried through to `Skill.Info`; absent
  means `undefined`.
- `session/system.ts` `collectAutoLoadedSkills` (~line 218-240): a skill is auto-loaded only if `alwaysApply === true` or its
  `applyPaths` globs match a file in the worktree. With neither, it `continue`s, so the body is NOT placed in the system prompt.
- `session/system.ts` `skills()` (~line 160-170) still renders every available skill via `Skill.fmt(filtered, {verbose: true})`:
  the system prompt contains "Skills provide specialized instructions and workflows for specific tasks. Use the skill tool to
  load a skill when a task matches its description." followed by an `<available_skills>` block with, for this arm, one entry:
  `<name>team-playbook</name>`, `<description>Conventions this team's CI and reviewers enforce, learned from past sessions.
  Apply them to related work.</description>`, `<location>file://.../.altimate-code/skills/team-playbook/SKILL.md</location>`.
- `tool/skill.ts` also embeds the same `<available_skills>` listing in the `skill` tool's description.
- The body (the 4 bullets) only enters context if the model calls the `skill` tool with `name: "team-playbook"`; the
  result is a `<skill_content name="team-playbook">` block. No `<auto_loaded_skill>` wrapper appears, so the harness's
  `playbook_in_context` probe is expected to be False for this arm; use the trace's `skill` tool span instead (analyze.py does).
- The description is generic (does not mention staging/dbt), so whether the model pulls it is the thing being measured.
- Agent permission `skill: deny` would suppress the whole section; the harness config only denies `external_directory`.
