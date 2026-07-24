import fs from "node:fs"
import path from "node:path"

/**
 * Marker file that identifies a directory as an altimate-code-materialized
 * starter sample. Written into the sample dir on first materialize;
 * consulted before any subsequent write to decide reuse / reset / suffix /
 * refuse.
 *
 * The marker is authoritative for filesystem safety. The KV entry
 * `KV_SAMPLE_PROJECT_PATH` is a convenience index; if KV and marker
 * disagree, the marker wins (KV gets rewritten on reconciliation).
 *
 * Codex's earlier concern: "looks like our sample" heuristic folder-sniffing
 * (files present, right names) can mis-classify a user's real dbt project
 * that happens to have the same layout. A dedicated JSON marker with a
 * required `kind` field avoids that entire failure mode.
 */

export const MARKER_FILE_NAME = ".altimate-sample.json"
export const MARKER_KIND = "altimate-starter-sample"

export interface SampleMarker {
  /** Always the constant MARKER_KIND. Any other value (or missing key) means
   *  "not our sample" and blocks overwrite. */
  kind: typeof MARKER_KIND
  /** Sample name (e.g. "jaffle-shop-duckdb"). Matches the source dir name. */
  sampleName: string
  /** Version from the sample's own sample-manifest.json at write time. */
  version: string
  /** ISO timestamp of materialization. */
  materializedAt: string
  /** altimate-code CLI version that wrote this marker. */
  cliVersion: string
}

/** Classification of a filesystem path as a candidate target for materializing
 *  the sample. Drives the conflict policy in materialize.ts. */
export type TargetState =
  | { kind: "empty" }
  | { kind: "our-sample-current"; marker: SampleMarker; path: string }
  | { kind: "our-sample-different-version"; marker: SampleMarker; path: string }
  | { kind: "unknown-dir"; path: string; reason: string }

/** Read `.altimate-sample.json` from a directory. Returns undefined if the
 *  file is missing, unreadable, malformed, or doesn't carry our `kind` tag. */
export function readMarker(dir: string): SampleMarker | undefined {
  const markerPath = path.join(dir, MARKER_FILE_NAME)
  try {
    const raw = fs.readFileSync(markerPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!isSampleMarker(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Write the marker atomically. Overwrites any existing marker in the dir.
 *  Caller MUST have already decided the dir is safe to write (via
 *  classifyTarget) — this function does not itself refuse. */
export function writeMarker(dir: string, marker: SampleMarker): void {
  const markerPath = path.join(dir, MARKER_FILE_NAME)
  const tmpPath = `${markerPath}.tmp-${process.pid}`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2) + "\n")
  fs.renameSync(tmpPath, markerPath) // atomic on POSIX
}

/** Classify a candidate materialization target. Never throws.
 *
 *  Decision table (documented here so the callers stay dumb):
 *  - No such dir             → empty (safe to create + materialize)
 *  - Empty dir               → empty (safe to materialize into)
 *  - Has our marker,
 *    version matches         → our-sample-current (reuse — nothing to do)
 *  - Has our marker,
 *    version differs         → our-sample-different-version (offer upgrade)
 *  - Non-empty dir,
 *    no marker (or bad kind) → unknown-dir (NEVER overwrite; caller must
 *                              suffix `-2`, `-3` etc. or refuse)
 */
export function classifyTarget(dir: string, expectedVersion: string): TargetState {
  let stat: fs.Stats | undefined
  try {
    stat = fs.statSync(dir)
  } catch {
    return { kind: "empty" }
  }
  if (!stat.isDirectory()) {
    return { kind: "unknown-dir", path: dir, reason: "target exists but is not a directory" }
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return {
      kind: "unknown-dir",
      path: dir,
      reason: `target unreadable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (entries.length === 0) return { kind: "empty" }

  const marker = readMarker(dir)
  if (!marker) {
    return {
      kind: "unknown-dir",
      path: dir,
      reason: "directory not empty and has no altimate-code marker (would clobber unrelated content)",
    }
  }
  if (marker.version === expectedVersion) {
    return { kind: "our-sample-current", marker, path: dir }
  }
  return { kind: "our-sample-different-version", marker, path: dir }
}

/** Given a base directory (parent) and preferred name, find the first
 *  candidate path that isn't blocked by unknown-dir content. Adds `-2`,
 *  `-3`, … suffix if `<base>/<name>/` is an unrelated dir.
 *  Caps at attemptLimit to avoid infinite loops in adversarial layouts. */
export function findSafeTarget(
  parentDir: string,
  preferredName: string,
  expectedVersion: string,
  attemptLimit: number = 10,
): { path: string; state: TargetState; suffix: number } {
  for (let i = 0; i < attemptLimit; i++) {
    const name = i === 0 ? preferredName : `${preferredName}-${i + 1}`
    const candidate = path.join(parentDir, name)
    const state = classifyTarget(candidate, expectedVersion)
    if (state.kind !== "unknown-dir") return { path: candidate, state, suffix: i }
  }
  throw new Error(
    `No safe target found under ${parentDir} — first ${attemptLimit} candidates all held unrelated content`,
  )
}

function isSampleMarker(v: unknown): v is SampleMarker {
  if (v === null || typeof v !== "object") return false
  const obj = v as Record<string, unknown>
  return (
    obj["kind"] === MARKER_KIND &&
    typeof obj["sampleName"] === "string" &&
    typeof obj["version"] === "string" &&
    typeof obj["materializedAt"] === "string" &&
    typeof obj["cliVersion"] === "string"
  )
}
