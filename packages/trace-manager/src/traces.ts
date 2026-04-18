import fs from "fs/promises"
import path from "path"
import os from "os"
import type { TraceFile } from "./types"

export const DEFAULT_TRACES_DIR = path.join(
  os.homedir(),
  ".local/share/altimate-code/traces",
)

export function getTracesDir(): string {
  return process.env.TRACES_DIR ?? DEFAULT_TRACES_DIR
}

export async function loadAllTraces(dir?: string): Promise<TraceFile[]> {
  const tracesDir = dir ?? getTracesDir()
  const files = await fs.readdir(tracesDir).catch(() => [])
  const jsonFiles = (files as string[]).filter(
    (f) => f.endsWith(".json") && !f.startsWith("."),
  )
  const traces: TraceFile[] = []
  for (const file of jsonFiles) {
    const content = await fs
      .readFile(path.join(tracesDir, file), "utf-8")
      .catch(() => null)
    if (!content) continue
    try {
      const trace = JSON.parse(content) as TraceFile
      if (trace.version === 2 && trace.sessionId) traces.push(trace)
    } catch {}
  }
  traces.sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  )
  return traces
}

export async function loadTrace(
  sessionId: string,
  dir?: string,
): Promise<TraceFile | null> {
  const traces = await loadAllTraces(dir)
  return (
    traces.find(
      (t) =>
        t.sessionId === sessionId || t.sessionId.startsWith(sessionId),
    ) ?? null
  )
}
