// altimate_change start — skill follow-up suggestions for conversational engagement
export namespace SkillFollowups {
  export interface Suggestion {
    skill: string // skill name to suggest
    label: string // short display label
    description: string // why this is a good next step
  }

  // Map from skill name to follow-up suggestions
  const FOLLOWUPS: Record<string, Suggestion[]> = {
    "dbt-develop": [
      {
        skill: "dbt-test",
        label: "Add tests",
        description: "Write schema tests and unit tests for the model you just created to ensure data quality.",
      },
      {
        skill: "dbt-docs",
        label: "Document your model",
        description: "Add descriptions to your model and columns in schema.yml for discoverability.",
      },
      {
        skill: "dbt-analyze",
        label: "Check downstream impact",
        description: "Analyze the blast radius of your changes on downstream models before merging.",
      },
      {
        skill: "sql-review",
        label: "Review SQL quality",
        description: "Run a quality gate on your SQL — lint for anti-patterns and grade readability.",
      },
    ],
    "dbt-troubleshoot": [
      {
        skill: "dbt-test",
        label: "Add regression tests",
        description: "Now that the bug is fixed, add tests to prevent it from recurring.",
      },
      {
        skill: "dbt-analyze",
        label: "Check downstream impact",
        description: "Verify your fix didn't break downstream models.",
      },
      {
        skill: "dbt-develop",
        label: "Improve the model",
        description: "Refactor or extend the model now that it's working correctly.",
      },
    ],
    "dbt-test": [
      {
        skill: "dbt-develop",
        label: "Build more models",
        description: "Continue building new models in your dbt project.",
      },
      {
        skill: "dbt-docs",
        label: "Document tested models",
        description: "Add documentation to the models you just tested.",
      },
    ],
    "dbt-docs": [
      {
        skill: "dbt-test",
        label: "Add tests",
        description: "Add data quality tests for the models you just documented.",
      },
      {
        skill: "dbt-analyze",
        label: "Analyze lineage",
        description: "Review column-level lineage to ensure documentation matches data flow.",
      },
    ],
    "dbt-analyze": [
      {
        skill: "dbt-test",
        label: "Add tests for affected models",
        description: "Add tests to downstream models that could be impacted by changes.",
      },
      {
        skill: "dbt-develop",
        label: "Make the changes",
        description: "Proceed with implementing the changes now that you understand the impact.",
      },
    ],
    "sql-review": [
      {
        skill: "query-optimize",
        label: "Optimize performance",
        description: "Improve query performance based on the review findings.",
      },
      {
        skill: "sql-translate",
        label: "Translate to another dialect",
        description: "Port this SQL to a different database dialect.",
      },
    ],
    "sql-translate": [
      {
        skill: "sql-review",
        label: "Review translated SQL",
        description: "Run a quality check on the translated SQL to catch dialect-specific issues.",
      },
    ],
    "query-optimize": [
      {
        skill: "sql-review",
        label: "Review optimized query",
        description: "Run a quality gate on the optimized SQL.",
      },
      {
        skill: "cost-report",
        label: "Check cost impact",
        description: "Analyze how the optimization affects query costs.",
      },
    ],
    "cost-report": [
      {
        skill: "query-optimize",
        label: "Optimize expensive queries",
        description: "Optimize the most expensive queries identified in the report.",
      },
    ],
    "pii-audit": [
      {
        skill: "sql-review",
        label: "Review SQL for PII exposure",
        description: "Check specific queries for PII leakage.",
      },
    ],
    "lineage-diff": [
      {
        skill: "dbt-analyze",
        label: "Full impact analysis",
        description: "Run a comprehensive impact analysis on the changed models.",
      },
      {
        skill: "dbt-test",
        label: "Add tests for changed paths",
        description: "Add tests covering the changed data flow paths.",
      },
    ],
    "schema-migration": [
      {
        skill: "dbt-develop",
        label: "Update dbt models",
        description: "Update your dbt models to reflect the schema changes.",
      },
    ],
  }

  // A special warehouse nudge for users who haven't connected yet
  const WAREHOUSE_NUDGE =
    "**Tip:** Connect a warehouse to validate against real data. Run `/discover` to auto-detect your connections."

  // altimate_change start — upstream_fix: guard against prototype pollution and deep-freeze suggestions
  export function get(skillName: string): readonly Suggestion[] {
    if (!Object.hasOwn(FOLLOWUPS, skillName)) return Object.freeze([])
    const suggestions = FOLLOWUPS[skillName]!
    return Object.freeze(suggestions.map((s) => Object.freeze({ ...s })))
  }
  // altimate_change end

  export function format(skillName: string): string {
    const suggestions = get(skillName)
    if (suggestions.length === 0) return ""

    const lines = [
      "",
      "---",
      "",
      "## What's Next?",
      "",
      "Now that this task is complete, here are suggested next steps:",
      "",
      ...suggestions.map(
        (s, i) => `${i + 1}. **${s.label}** — ${s.description} → Use \`/skill ${s.skill}\` or just ask me.`,
      ),
      "",
      WAREHOUSE_NUDGE,
      "",
      "*You can continue this conversation — just type your next request.*",
    ]
    return lines.join("\n")
  }
}
// altimate_change end
