import fs from "fs/promises"
import path from "path"
import os from "os"
import type { TraceManagerConfig, PIIAction, PIICategory } from "../types"

const CONFIG_DIR = path.join(os.homedir(), ".altimate")
const CONFIG_FILE = "trace-manager.json"

export function configPath(): string {
  return process.env.TRACE_MANAGER_CONFIG ?? path.join(CONFIG_DIR, CONFIG_FILE)
}

export function createDefaultConfig(): TraceManagerConfig {
  return {
    version: 1,
    consent: {
      acceptedAt: new Date().toISOString(),
      piiCategories: {
        email: "redact",
        api_key: "redact",
        ip_address: "hash",
        file_path: "allow",
        name: "hash",
        phone: "redact",
        ssn: "redact",
        credit_card: "redact",
      },
      customPatterns: [],
      autoPublish: false,
      autoIngest: false,
      retentionDays: 90,
    },
    publish: { endpoints: [] },
    lake: {
      path: process.env.TRACE_MANAGER_LAKE ?? path.join(os.homedir(), ".altimate/trace-lake.duckdb"),
    },
  }
}

export async function loadConfig(): Promise<TraceManagerConfig | null> {
  const p = configPath()
  const raw = await fs.readFile(p, "utf-8").catch(() => null)
  if (!raw) return null
  const parsed = JSON.parse(raw)
  if (parsed.version !== 1) throw new Error(`Unsupported trace-manager config version: ${parsed.version}`)
  return parsed as TraceManagerConfig
}

export async function saveConfig(config: TraceManagerConfig): Promise<void> {
  const p = configPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(config, null, 2) + "\n")
}

export async function loadOrCreateConfig(): Promise<TraceManagerConfig> {
  const existing = await loadConfig()
  if (existing) return existing
  const config = createDefaultConfig()
  await saveConfig(config)
  return config
}

export const PII_CATEGORY_LABELS: Record<PIICategory, string> = {
  email: "Email addresses",
  api_key: "API keys & tokens",
  ip_address: "IP addresses",
  file_path: "File paths",
  name: "Personal names",
  phone: "Phone numbers",
  ssn: "SSN / national IDs",
  credit_card: "Credit card numbers",
}

export const PII_ACTION_LABELS: Record<PIIAction, string> = {
  redact: "Replace with [REDACTED]",
  hash: "SHA-256 hash (first 8 chars)",
  allow: "Keep as-is",
}
