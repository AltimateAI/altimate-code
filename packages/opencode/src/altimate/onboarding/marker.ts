import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Marker file that identifies a directory as an altimate-code-materialized
 * starter sample. Written into the sample dir on first materialize;
 * consulted before any subsequent write to decide reuse / reset / suffix /
 * refuse.
 *
 * The marker is authoritative for filesystem safety.
 *
 * A "looks like our sample" heuristic (files present, right names) would
 * mis-classify a user's real dbt project that happens to have the same
 * layout. A dedicated JSON marker with a required `kind` field avoids
 * that entire failure mode.
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
 *    sampleName differs      → unknown-dir (marker is ours but belongs to
 *                              a DIFFERENT sample — never reuse or upgrade
 *                              through it; treat as a foreign directory)
 *  - Has our marker,
 *    sampleName matches,
 *    version matches         → our-sample-current (reuse — nothing to do)
 *  - Has our marker,
 *    sampleName matches,
 *    version differs         → our-sample-different-version (offer upgrade)
 *  - Non-empty dir,
 *    no marker (or bad kind) → unknown-dir (NEVER overwrite; caller must
 *                              suffix `-2`, `-3` etc. or refuse)
 *
 *  `expectedSampleName` gates the marker's `sampleName` field so an existing
 *  sample-A marker never satisfies a sample-B request. Currently the shipped
 *  CLI only carries jaffle-shop-duckdb, so this branch is unreachable in
 *  practice — but a future second sample must not silently reuse an existing
 *  first-sample dir just because the version happens to match.
 */
export function classifyTarget(
  dir: string,
  expectedVersion: string,
  expectedSampleName: string,
): TargetState {
  // lstatSync (not statSync) so a symlinked target is classified as
  // unknown-dir rather than by what it points at. If a user has
  // ~/altimate-sample-dbt -> /somewhere-else, we must not "reuse" the
  // symlink target through the link (that would place downstream operations
  // outside the parent our containment check validated) and must not
  // silently unlink the symlink when overwriting an "empty" directory.
  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return { kind: "empty" }
  }
  if (stat.isSymbolicLink()) {
    return { kind: "unknown-dir", path: dir, reason: "target is a symlink — refusing to follow" }
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
  // Gate on sampleName BEFORE version. A marker whose sampleName differs
  // from what we're materializing is not "ours" for THIS request — even
  // though it was written by an altimate-code CLI. Treat it as a foreign
  // directory: never reuse-through it, never authorize an
  // allowInPlaceUpgrade against it. Falls into the same suffix escalation
  // path as an unrelated non-sample dir.
  if (marker.sampleName !== expectedSampleName) {
    return {
      kind: "unknown-dir",
      path: dir,
      reason: `marker belongs to sample '${marker.sampleName}', not '${expectedSampleName}' — refusing to reuse or overwrite a different sample`,
    }
  }
  if (marker.version === expectedVersion) {
    return { kind: "our-sample-current", marker, path: dir }
  }
  return { kind: "our-sample-different-version", marker, path: dir }
}

/** Verify the parent dir is writable BEFORE we start hunting candidates —
 *  gives the caller a specific "target parent unwritable" error instead of
 *  a raw `EACCES` from `mkdirSync` deep in the materialize step.
 *  Returns undefined when writable; a message string when not. */
export function checkParentWritable(parentDir: string): string | undefined {
  try {
    fs.accessSync(parentDir, fs.constants.W_OK)
    return undefined
  } catch (err) {
    return `Target parent directory ${parentDir} is not writable: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Given a base directory (parent) and preferred name, find the first
 *  candidate path that isn't blocked by unknown-dir content.
 *
 *  Attempts, in order:
 *   1. `<parentDir>/<preferredName>/`
 *   2. `<parentDir>/<preferredName>-2/`, `-3/`, …, up to `attemptLimit`
 *   3. If ALL of the numbered slots are held by unrelated content, one
 *      final randomized fallback `<preferredName>-<6-hex-chars>/` — this
 *      keeps activation working for the pathological case where a user
 *      has 100 unrelated altimate-sample-dbt-N/ dirs (retries, support
 *      copies, benchmark runs). Better a weird name than a hard failure.
 *   4. If even the randomized slot collides (statistical near-impossible
 *      given 16.7M random values), THEN throw.
 *
 *  Bumped attemptLimit from 10 → 100 after cubic feedback that 10 is easy
 *  to blow past in real environments.
 */
/** After this many consecutive UNRELATED-content hits, findSafeTarget stops
 *  scanning numbered slots and jumps straight to the randomized fallback.
 *  A user with 5+ contiguous unknown dirs under their preferred name is in
 *  a genuinely crowded parent; scanning the rest of the 100 numbered slots
 *  would burn ~95 unnecessary stat syscalls to arrive at the same answer.
 *  Kept generous enough to survive the common "installer created 2-3
 *  numbered copies during retries" pattern without escalating to hex. */
const CONSECUTIVE_UNKNOWN_LIMIT = 10

export function findSafeTarget(
  parentDir: string,
  preferredName: string,
  expectedVersion: string,
  expectedSampleName: string,
  attemptLimit: number = 100,
  opts: {
    /** When true, treat `our-sample-different-version` the same as `unknown-dir`
     *  during slot scanning — skip it and try the next slot. Used by the
     *  install-alongside upgrade flow so a user with slot 0 holding an
     *  older-version sample can materialize the new version into slot 1
     *  (`<name>-2`) without touching the old one. Without this option,
     *  findSafeTarget stops at a version-mismatched slot 0 and returns —
     *  which is the right default for reuse detection, but blocks the
     *  "install the new version alongside" UX. */
    skipVersionMismatch?: boolean
  } = {},
): { path: string; state: TargetState; suffix: number | string } {
  const skippable = (kind: TargetState["kind"]): boolean =>
    kind === "unknown-dir" || (Boolean(opts.skipVersionMismatch) && kind === "our-sample-different-version")
  let consecutiveSkipped = 0
  for (let i = 0; i < attemptLimit; i++) {
    const name = i === 0 ? preferredName : `${preferredName}-${i + 1}`
    const candidate = path.join(parentDir, name)
    const state = classifyTarget(candidate, expectedVersion, expectedSampleName)
    if (!skippable(state.kind)) return { path: candidate, state, suffix: i }
    consecutiveSkipped++
    // The parent has enough unrelated content that continuing the numeric
    // scan is unlikely to find a free slot. Skip to the hex fallback which
    // has a ~16.7M-value collision space and will resolve in one syscall.
    if (consecutiveSkipped >= CONSECUTIVE_UNKNOWN_LIMIT) break
  }
  // Randomized fallback — 6 hex chars is ~16.7M values; if it collides we
  // give up (the environment is genuinely hostile).
  const randomTag = randomBytes(3).toString("hex")
  const randomName = `${preferredName}-${randomTag}`
  const randomCandidate = path.join(parentDir, randomName)
  const state = classifyTarget(randomCandidate, expectedVersion, expectedSampleName)
  if (!skippable(state.kind)) {
    return { path: randomCandidate, state, suffix: randomTag }
  }
  throw new Error(
    `No safe target found under ${parentDir} — numbered candidates AND a randomized fallback ${randomName} all held unrelated content`,
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
