import {
  createDefaultConfig,
  saveConfig,
  loadConfig,
  PII_CATEGORY_LABELS,
  PII_ACTION_LABELS,
} from "./consent-store"
import type { PIIAction, PIICategory, TraceManagerConfig } from "../types"

const ACTIONS: PIIAction[] = ["redact", "hash", "allow"]
const CATEGORIES: PIICategory[] = ["email", "api_key", "ip_address", "file_path", "name", "phone", "ssn", "credit_card"]

function printHeader(isReconfigure: boolean) {
  console.log("")
  console.log("╭─────────────────────────────────────────────────────────╮")
  console.log("│              Altimate Code — Trace Manager               │")
  console.log("│                    Security Guide                        │")
  console.log("╰─────────────────────────────────────────────────────────╯")
  console.log("")
  if (!isReconfigure) {
    console.log("  Altimate Code records session traces locally to help you")
    console.log("  review, debug, and improve your coding sessions.")
    console.log("")
    console.log("  Before we start, let's configure what data stays private.")
    console.log("  Nothing leaves your machine unless you explicitly publish.")
  } else {
    console.log("  Reconfiguring your trace privacy settings.")
  }
  console.log("")
  console.log("─────────────────────────────────────────────────────────")
  console.log("")
}

function printCurrentSettings(config: TraceManagerConfig) {
  console.log("  PII Category            Action")
  console.log("  ────────────────────    ──────────────────")
  for (const cat of CATEGORIES) {
    const action = config.consent.piiCategories[cat] ?? "redact"
    const label = PII_CATEGORY_LABELS[cat].padEnd(22)
    const actionLabel = PII_ACTION_LABELS[action]
    console.log(`  ${label}  ${action.padEnd(8)} (${actionLabel})`)
  }
  console.log("")
  console.log(`  Auto-publish:       ${config.consent.autoPublish ? "yes" : "no"}`)
  console.log(`  Auto-ingest to lake: ${config.consent.autoIngest ? "yes" : "no"}`)
  console.log(`  Retention:          ${config.consent.retentionDays} days`)
  console.log("")
}

export async function runSecurityGuide(options?: { interactive?: boolean }): Promise<TraceManagerConfig> {
  const existing = await loadConfig()
  const isReconfigure = !!existing
  const config = existing ?? createDefaultConfig()

  printHeader(isReconfigure)

  if (isReconfigure) {
    console.log("  Current settings:")
    console.log("")
    printCurrentSettings(config)
  }

  if (options?.interactive === false) {
    if (!isReconfigure) {
      console.log("  Using default privacy settings (conservative):")
      console.log("")
      printCurrentSettings(config)
      config.consent.acceptedAt = new Date().toISOString()
      await saveConfig(config)
      console.log("  ✓ Preferences saved to " + (await import("./consent-store")).configPath())
      console.log("  ✓ Change anytime: altimate-code trace-manage consent")
      console.log("")
    }
    return config
  }

  console.log("  Configure PII handling (press Enter to accept defaults):")
  console.log("")

  for (const cat of CATEGORIES) {
    const current = config.consent.piiCategories[cat] ?? "redact"
    const label = PII_CATEGORY_LABELS[cat]
    const prompt = `  ${label} [${current}]: `
    process.stdout.write(prompt)

    const line = await readLine()
    const trimmed = line.trim().toLowerCase()
    if (trimmed && ACTIONS.includes(trimmed as PIIAction)) {
      config.consent.piiCategories[cat] = trimmed as PIIAction
    }
  }

  console.log("")
  process.stdout.write("  Review PII before every publish? [Y/n]: ")
  const reviewAnswer = (await readLine()).trim().toLowerCase()
  config.consent.autoPublish = reviewAnswer === "n" || reviewAnswer === "no"

  process.stdout.write("  Auto-ingest traces into analytics lake? [y/N]: ")
  const ingestAnswer = (await readLine()).trim().toLowerCase()
  config.consent.autoIngest = ingestAnswer === "y" || ingestAnswer === "yes"

  config.consent.acceptedAt = new Date().toISOString()
  await saveConfig(config)

  console.log("")
  console.log("─────────────────────────────────────────────────────────")
  console.log("")
  console.log("  ✓ Preferences saved to " + (await import("./consent-store")).configPath())
  console.log("  ✓ Change anytime: altimate-code trace-manage consent")
  console.log("")

  return config
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    const onData = (chunk: Buffer) => {
      const str = chunk.toString()
      if (str.includes("\n")) {
        data += str.split("\n")[0]
        process.stdin.off("data", onData)
        if (wasRaw) process.stdin.setRawMode?.(false)
        process.stdin.pause()
        resolve(data)
        return
      }
      data += str
    }
    let wasRaw = false
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false)
    }
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}
