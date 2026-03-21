import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
// altimate_change start — import helpers for tool detection and source classification
import { detectToolReferences, skillSource } from "../../skill-helpers"
// altimate_change end

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  dialog.setSize("large")

  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  // altimate_change start — enrich skill list with source and paired tools
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => {
      const source = skillSource(skill.location)
      const tools = detectToolReferences(skill.content)
      const toolStr = tools.length > 0 ? tools.join(", ") : undefined
      return {
        title: skill.name.padEnd(maxWidth),
        description: skill.description?.replace(/\s+/g, " ").trim(),
        footer: toolStr ? `Tools: ${toolStr}` : undefined,
        value: skill.name,
        category: source === "builtin" ? "Built-in" : source === "global" ? "Global" : "Project",
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
