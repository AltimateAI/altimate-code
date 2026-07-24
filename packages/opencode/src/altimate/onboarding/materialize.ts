import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MARKER_KIND, checkParentWritable, findSafeTarget, writeMarker, type TargetState } from "./marker"
import { DEFAULT_SAMPLE_NAME, resolveSampleSource } from "./sample-source-resolver"

/**
 * Materialize the shipped starter sample onto the user's filesystem.
 *
 * The user-facing contract:
 *   - Default target: `~/altimate-sample-dbt/` (visible, user can `cd` in).
 *   - If the target already holds our sample at the same version → reuse
 *     the existing dir (no rewrite).
 *   - If the target holds our sample at a different version → reset in
 *     place (the caller has already confirmed via UX).
 *   - If the target holds anything unrelated → find `<target>-2/`, `-3/`,
 *     … and materialize there. Never overwrite unknown content.
 *   - If HOME resolves to a suspicious location (npm sudo `/root`, an
 *     ephemeral `/tmp/*` runner, a container's `/`) → refuse with an
 *     actionable error. The user probably didn't mean to write there.
 *
 * The copy is done through a whitelist of files that the shipped sample
 * source is known to contain, rather than a wholesale recursive copy —
 * this keeps sample-projects/ contributor edits from accidentally shipping
 * developer scratch files (partial_parse.msgpack, .venv, .DS_Store, …) to
 * end users.
 */

/** Files/dirs relative to the sample source that get materialized to the
 *  user's target dir. Explicitly enumerated (no glob) so future changes
 *  to the sample layout are a deliberate opt-in edit here. */
const MATERIALIZE_ENTRIES: ReadonlyArray<{ from: string; kind: "file" | "dir" }> = [
  { from: "README.md", kind: "file" },
  { from: "dbt_project.yml", kind: "file" },
  { from: "profiles.yml", kind: "file" },
  { from: "sample-manifest.json", kind: "file" },
  { from: ".gitignore", kind: "file" },
  { from: "models", kind: "dir" },
  { from: "seeds", kind: "dir" },
  { from: "target/manifest.json", kind: "file" },
]

export interface MaterializeOptions {
  /** Sample-source lookup name (defaults to jaffle-shop-duckdb). */
  sampleName?: string
  /** Preferred target directory NAME (not full path). Suffixed to
   *  `<targetParent>/<preferredTargetName>` unless already taken. */
  preferredTargetName?: string
  /** Parent directory that the target lands in. Defaults to `os.homedir()`
   *  after passing the safety guard (see rejectUnsafeHome). */
  targetParent?: string
  /** altimate-code version, written into the marker. */
  cliVersion: string
  /** Sample version, written into the marker. Should mirror the value in
   *  sample-manifest.json (materialize.ts DOES NOT read it — the caller
   *  is expected to pass the same version it stamped into publish). */
  sampleVersion: string
  /** If true and the classifier returned `our-sample-different-version`,
   *  overwrite in place. If false and versions differ, the caller gets a
   *  MaterializeResult with `reused: false` + a hint to prompt the user. */
  allowInPlaceUpgrade?: boolean
}

export interface MaterializeResult {
  /** Absolute path where the sample ended up. */
  targetPath: string
  /** true when the target already held our sample at the requested version
   *  (no write was performed except possibly a marker-timestamp refresh). */
  reused: boolean
  /** Which slot was used: 0 for the preferred name, N for `-<N+1>`,
   *  a hex string for the randomized fallback slot. */
  suffix: number | string
  /** Debug-worthy note about the state classification at write time. */
  note: string
}

/**
 * Refuse to write into a `HOME` that's almost certainly wrong.
 * Concrete cases:
 * - `/root` — someone ran `sudo npm install -g` and their shell isn't
 *   actually root; the sample would land in root's home and be invisible.
 * - `/tmp/*` — ephemeral runners; user won't find it later.
 * - `/` — misconfigured containers.
 * - unset — Windows sometimes; leave to the caller.
 */
export function rejectUnsafeHome(home: string | undefined): string | undefined {
  if (!home) return "HOME environment variable is not set"
  if (home === "/" || home === "") return `HOME='${home}' is not a usable directory`
  if (home === "/root" && process.getuid?.() !== 0) {
    return "HOME=/root but this process is not running as root (likely `sudo npm install -g` — the sample would materialize into root's home and be invisible from your normal shell). Re-run without sudo, or pass an explicit `--target-parent`."
  }
  if (home.startsWith("/tmp/") || home === "/tmp") {
    return `HOME='${home}' is an ephemeral tmp path — the sample would disappear on reboot. Pass an explicit --target-parent to override.`
  }
  return undefined
}

export async function materializeSample(opts: MaterializeOptions): Promise<MaterializeResult> {
  const sampleName = opts.sampleName ?? DEFAULT_SAMPLE_NAME
  const preferredName = opts.preferredTargetName ?? "altimate-sample-dbt"

  const targetParent = opts.targetParent ?? os.homedir()
  const homeReject = opts.targetParent ? undefined : rejectUnsafeHome(targetParent)
  if (homeReject) {
    throw new Error(homeReject)
  }

  // Fail loudly on unwritable parents (read-only home, NFS glitch, container
  // mount) BEFORE we start hunting candidate names — gives the caller a
  // clean error instead of a raw EACCES from mkdirSync mid-copy.
  const writableError = checkParentWritable(targetParent)
  if (writableError) {
    throw new Error(writableError)
  }

  const source = resolveSampleSource(sampleName)
  if (!source) {
    throw new Error(
      `Could not locate the starter sample source ('${sampleName}'). This usually means the CLI was installed without its wrapper package assets. Reinstall with: npm i -g @altimateai/altimate-code@latest`,
    )
  }

  const { path: targetPath, state, suffix } = findSafeTarget(targetParent, preferredName, opts.sampleVersion)

  // If we found our sample at the requested version, we're done — no
  // write. The user's existing edits (SQL tweaks, seed additions) are
  // preserved intact.
  if (state.kind === "our-sample-current") {
    return {
      targetPath,
      reused: true,
      suffix,
      note: `reused ${targetPath} (marker version ${state.marker.version} matches)`,
    }
  }

  // Different version. Only overwrite if the caller opted in.
  if (state.kind === "our-sample-different-version" && !opts.allowInPlaceUpgrade) {
    return {
      targetPath,
      reused: true,
      suffix,
      note: `found existing sample at ${targetPath} version ${state.marker.version}, but current version is ${opts.sampleVersion}. Caller must prompt user before allowInPlaceUpgrade=true.`,
    }
  }

  copySampleTree(source.path, targetPath)
  writeMarker(targetPath, {
    kind: MARKER_KIND,
    sampleName,
    version: opts.sampleVersion,
    materializedAt: new Date().toISOString(),
    cliVersion: opts.cliVersion,
  })

  return {
    targetPath,
    reused: false,
    suffix,
    note: buildNote(state, targetPath, suffix),
  }
}

function copySampleTree(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of MATERIALIZE_ENTRIES) {
    const from = path.join(source, entry.from)
    const to = path.join(target, entry.from)
    if (!fs.existsSync(from)) continue // .gitignore is optional; skip quietly
    if (entry.kind === "dir") {
      fs.cpSync(from, to, { recursive: true, force: true })
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
  }
}

function buildNote(state: TargetState, target: string, suffix: number | string): string {
  if (state.kind === "empty" && suffix === 0) return `fresh materialize into ${target}`
  if (state.kind === "empty" && typeof suffix === "number" && suffix > 0)
    return `fresh materialize into ${target} (preferred name was taken by unrelated content — used numeric suffix -${suffix + 1})`
  if (state.kind === "empty" && typeof suffix === "string")
    return `fresh materialize into ${target} (all numeric slots were taken — used randomized suffix)`
  if (state.kind === "our-sample-different-version")
    return `in-place upgrade of ${target} from version ${state.marker.version} to current`
  return `materialized into ${target}`
}
