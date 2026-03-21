import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
// altimate_change start — import helpers for tool detection
import { detectToolReferences } from "../../skill-helpers"
// altimate_change end

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

// altimate_change start — categorize skills by domain for cleaner grouping
const SKILL_CATEGORIES: Record<string, string> = {
  "dbt-develop": "dbt",
  "dbt-test": "dbt",
  "dbt-docs": "dbt",
  "dbt-analyze": "dbt",
  "dbt-troubleshoot": "dbt",
  "sql-review": "SQL",
  "sql-translate": "SQL",
  "query-optimize": "SQL",
  "schema-migration": "Schema",
  "pii-audit": "Schema",
  "cost-report": "FinOps",
  "lineage-diff": "Lineage",
  "data-viz": "Visualization",
  "train": "Training",
  "teach": "Training",
  "training-status": "Training",
  "altimate-setup": "Setup",
}
// altimate_change end

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  dialog.setSize("large")

  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  // altimate_change start — enrich skill list with domain categories and tool info
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => {
      const tools = detectToolReferences(skill.content)
      const category = SKILL_CATEGORIES[skill.name] ?? "Other"
      // Truncate description to keep it readable in the dialog
      const desc = skill.description?.replace(/\s+/g, " ").trim()
      const shortDesc = desc && desc.length > 80 ? desc.slice(0, 77) + "..." : desc
      return {
        title: skill.name.padEnd(maxWidth),
        description: shortDesc,
        footer: tools.length > 0 ? `⚡ ${tools.slice(0, 2).join(", ")}` : undefined,
        value: skill.name,
        category,
        onSelect: () => {
          props.onSelect(skill.name)
          dialog.clear()
        },
      }
    })
  })
  // altimate_change end

  return <DialogSelect title="Skills" placeholder="Search skills..." options={options()} />
}
