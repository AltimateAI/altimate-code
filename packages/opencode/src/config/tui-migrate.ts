import path from "path"
import { type ParseError as JsoncParseError, applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
// altimate_change — upstream_fix: group legacy migration sources by destination directory
import { groupBy, unique } from "remeda"
import { Option, Schema } from "effect"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import * as ConfigPaths from "@/config/paths"

// altimate_change start — schema URL points to altimate.ai (was opencode.ai)
const TUI_SCHEMA_URL = "https://altimate.ai/tui.json"
// altimate_change end

const decodeTheme = Schema.decodeUnknownOption(Schema.String)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeScrollSpeed = Schema.decodeUnknownOption(TuiConfig.ScrollSpeed)
const decodeScrollAcceleration = Schema.decodeUnknownOption(TuiConfig.ScrollAcceleration)
const decodeDiffStyle = Schema.decodeUnknownOption(TuiConfig.DiffStyle)

interface MigrateInput {
  cwd: string
  directories: string[]
  // altimate_change start — upstream_fix: restore worktree-bounded TUI migration
  worktree: string
  // altimate_change end
  // altimate_change start — upstream_fix: include managed config dir in TUI migration
  managed?: string
  // altimate_change end
}

/**
 * Migrates tui-specific keys (theme, keybinds, tui) from project config files
 * into dedicated tui.json files. Migration is performed per-directory and
 * skips only locations where a tui.json already exists.
 */
// altimate_change start — upstream_fix: merge same-directory legacy TUI settings before writing the target
export async function migrateTuiConfig(input: MigrateInput) {
  const opencode = await opencodeFiles(input)
  for (const files of Object.values(groupBy(opencode, (file) => path.dirname(file)))) {
    const target = path.join(path.dirname(files[0]), "tui.json")
    if (await Filesystem.exists(target)) continue

    const payload: Record<string, unknown> = { $schema: TUI_SCHEMA_URL }
    const sources: { file: string; source: string }[] = []
    // Discovery is highest precedence first. Merge in reverse so missing keys
    // survive while higher-priority values replace conflicting ones.
    for (const file of files.toReversed()) {
      const source = await Filesystem.readText(file).catch(() => undefined)
      if (!source) continue
      const errors: JsoncParseError[] = []
      const data = parseJsonc(source, errors, { allowTrailingComma: true })
      if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) continue

      const theme = Option.getOrUndefined(decodeTheme(data.theme))
      const keybinds = Option.getOrUndefined(decodeRecord(data.keybinds))
      const legacyTui = Option.getOrUndefined(decodeRecord(data.tui))
      const tui = legacyTui ? normalizeTui(legacyTui) : undefined
      if (theme === undefined && keybinds === undefined && !tui) continue

      if (theme !== undefined) payload.theme = theme
      if (keybinds !== undefined) payload.keybinds = { ...(payload.keybinds as Record<string, unknown>), ...keybinds }
      if (tui) {
        for (const [key, value] of Object.entries(tui)) {
          if (value !== undefined) payload[key] = value
        }
      }
      sources.push({ file, source })
    }
    if (!sources.length) continue

    const wrote = await Filesystem.write(target, JSON.stringify(payload, null, 2))
      .then(() => true)
      .catch(() => false)
    if (!wrote) continue
    for (const { file, source } of sources) await backupAndStripLegacy(file, source)
  }
}
// altimate_change end

function normalizeTui(data: Record<string, unknown>):
  | {
      scroll_speed: number | undefined
      scroll_acceleration: { enabled: boolean } | undefined
      diff_style: "auto" | "stacked" | undefined
    }
  | undefined {
  const parsed = {
    scroll_speed: Option.getOrUndefined(decodeScrollSpeed(data.scroll_speed)),
    scroll_acceleration: Option.getOrUndefined(decodeScrollAcceleration(data.scroll_acceleration)),
    diff_style: Option.getOrUndefined(decodeDiffStyle(data.diff_style)),
  }
  return parsed.scroll_speed === undefined &&
    parsed.diff_style === undefined &&
    parsed.scroll_acceleration === undefined
    ? undefined
    : parsed
}

async function backupAndStripLegacy(file: string, source: string) {
  const backup = file + ".tui-migration.bak"
  const hasBackup = await Filesystem.exists(backup)
  const backed = hasBackup
    ? true
    : await Filesystem.write(backup, source)
        .then(() => true)
        .catch(() => false)
  if (!backed) return false

  const text = ["theme", "keybinds", "tui"].reduce((acc, key) => {
    const edits = modify(acc, [key], undefined, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    if (!edits.length) return acc
    return applyEdits(acc, edits)
  }, source)

  return Filesystem.write(file, text)
    .then(() => true)
    .catch(() => false)
}

// altimate_change start — upstream_fix: accept managed config dir for TUI migration
async function opencodeFiles(input: { directories: string[]; cwd: string; worktree: string; managed?: string }) {
  // altimate_change end
  // altimate_change start — upstream Filesystem.findUp(array, …, {rootFirst}) collapsed to Filesystem.up();
  // collect the generator and reverse to preserve the original root-first ordering.
  // altimate_change start — upstream_fix: restore worktree-bounded TUI migration
  const walkedUp = (
    await Array.fromAsync(
      Filesystem.up({ targets: [...ConfigPaths.projectConfigNames], start: input.cwd, stop: input.worktree }),
    )
  ).reverse()
  // altimate_change end
  const files = [...ConfigPaths.fileInDirectory(Global.Path.config, "opencode"), ...walkedUp]
  // altimate_change end
  for (const dir of unique(input.directories)) {
    // altimate_change start — config directories also load branded names, below the legacy names
    files.push(...ConfigPaths.fileInDirectory(dir, "opencode"), ...ConfigPaths.fileInDirectory(dir, "altimate-code"))
    // altimate_change end
  }
  if (Flag.OPENCODE_CONFIG) files.push(Flag.OPENCODE_CONFIG)
  // altimate_change start — upstream_fix: include managed config dir in TUI migration
  if (input.managed) files.push(...ConfigPaths.fileInDirectory(input.managed, "opencode"))
  // altimate_change end

  const existing = await Promise.all(
    unique(files).map(async (file) => {
      const ok = await Filesystem.exists(file)
      return ok ? file : undefined
    }),
  )
  return existing.filter((file): file is string => !!file)
}
