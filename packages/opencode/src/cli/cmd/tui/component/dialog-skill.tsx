import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
// altimate_change start — import helpers for tool detection, keybind support, and prompt dialog
import { detectToolReferences } from "../../skill-helpers"
import { Keybind } from "@/util/keybind"
import { useToast } from "@tui/ui/toast"
import { spawn } from "child_process"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
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

// altimate_change start — sub-dialogs for create and install
function DialogSkillCreate() {
  const dialog = useDialog()
  const toast = useToast()

  return (
    <DialogPrompt
      title="Create Skill"
      placeholder="my-tool"
      onConfirm={async (name) => {
        dialog.clear()
        toast.show({ message: `Creating ${name}...`, variant: "info" })
        try {
          const proc = Bun.spawn(["altimate-code", "skill", "create", name], {
            stdout: "pipe",
            stderr: "pipe",
          })
          await proc.exited
          const stdout = await new Response(proc.stdout).text()
          const stderr = await new Response(proc.stderr).text()
          if (proc.exitCode === 0) {
            toast.show({ message: `✓ Created skill "${name}"\n${stdout.trim()}`, variant: "success", duration: 5000 })
          } else {
            toast.show({ message: stderr.trim() || `Failed to create "${name}"`, variant: "error", duration: 5000 })
          }
        } catch {
          toast.show({ message: `Failed to create "${name}"`, variant: "error" })
        }
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

function DialogSkillInstall() {
  const dialog = useDialog()
  const toast = useToast()

  return (
    <DialogPrompt
      title="Install Skill (owner/repo, URL, or path)"
      placeholder="anthropics/skills"
      onConfirm={async (source) => {
        dialog.clear()
        toast.show({ message: `Installing from ${source}...`, variant: "info" })
        try {
          const proc = Bun.spawn(["altimate-code", "skill", "install", source], {
            stdout: "pipe",
            stderr: "pipe",
          })
          await proc.exited
          const stdout = await new Response(proc.stdout).text()
          const stderr = await new Response(proc.stderr).text()
          if (proc.exitCode === 0) {
            toast.show({ message: stdout.trim(), variant: "success", duration: 6000 })
          } else {
            toast.show({ message: stderr.trim() || `Failed to install from "${source}"`, variant: "error", duration: 5000 })
          }
        } catch {
          toast.show({ message: `Failed to install from "${source}"`, variant: "error" })
        }
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
// altimate_change end

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  dialog.setSize("large")

  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  // altimate_change start — build lookups from skill name → location/content for actions
  const skillMap = createMemo(() => {
    const map = new Map<string, { location: string; content: string; description: string }>()
    for (const skill of skills() ?? []) {
      map.set(skill.name, { location: skill.location, content: skill.content, description: skill.description })
    }
    return map
  })
  // altimate_change end

  // altimate_change start — enrich skill list with domain categories and tool info
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => {
      const tools = detectToolReferences(skill.content)
      const category = SKILL_CATEGORIES[skill.name] ?? "Other"
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

  // Keybind actions: view, edit, test, create, install
  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("ctrl+o")[0],
      title: "view",
      onTrigger: async (option: DialogSelectOption<string>) => {
        const info = skillMap().get(option.value)
        if (!info) return
        const tools = detectToolReferences(info.content)
        const lines = [
          `Skill: ${option.value}`,
          info.description,
          "",
          `Location: ${info.location}`,
          tools.length > 0 ? `Tools: ${tools.join(", ")}` : null,
          "",
          "Content:",
          "─".repeat(40),
          info.content.slice(0, 800) + (info.content.length > 800 ? "\n..." : ""),
        ]
          .filter((l) => l !== null)
          .join("\n")
        toast.show({ message: lines, variant: "info", duration: 10000 })
      },
    },
    {
      keybind: Keybind.parse("ctrl+e")[0],
      title: "edit",
      onTrigger: async (option: DialogSelectOption<string>) => {
        const info = skillMap().get(option.value)
        if (!info || info.location.startsWith("builtin:")) {
          toast.show({ message: "Cannot edit built-in skills", variant: "info" })
          return
        }
        const editor = process.env.EDITOR || process.env.VISUAL || "vi"
        dialog.clear()
        spawn(editor, [info.location], { stdio: "inherit", detached: true }).unref()
      },
    },
    {
      keybind: Keybind.parse("ctrl+t")[0],
      title: "test",
      onTrigger: async (option: DialogSelectOption<string>) => {
        toast.show({ message: `Testing ${option.value}...`, variant: "info" })
        try {
          const proc = Bun.spawn(["altimate-code", "skill", "test", option.value], {
            stdout: "pipe",
            stderr: "pipe",
          })
          const exitCode = await proc.exited
          const output = await new Response(proc.stdout).text()
          const passed = output.includes("PASS")
          toast.show({
            message: passed ? `✓ ${option.value}: PASS` : `✗ ${option.value}: FAIL`,
            variant: passed ? "success" : "error",
            duration: 4000,
          })
        } catch {
          toast.show({ message: `Failed to test ${option.value}`, variant: "error" })
        }
      },
    },
    {
      keybind: Keybind.parse("ctrl+n")[0],
      title: "create",
      onTrigger: async () => {
        dialog.replace(() => <DialogSkillCreate />)
      },
    },
    {
      keybind: Keybind.parse("ctrl+i")[0],
      title: "install",
      onTrigger: async () => {
        dialog.replace(() => <DialogSkillInstall />)
      },
    },
  ])
  // altimate_change end

  return (
    <DialogSelect
      title="Skills"
      placeholder="Search skills..."
      options={options()}
      keybind={keybinds()}
    />
  )
}
