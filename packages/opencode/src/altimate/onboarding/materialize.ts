import { randomBytes } from "node:crypto"
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

/**
 * Directory names permitted for `preferredTargetName`. Deliberately restrictive:
 * one path segment, no traversal characters, no leading dot (which would create
 * a hidden dir the user might not notice).
 *
 * Path traversal guard: the LLM-facing sample_setup tool exposes
 * `preferredTargetName` as a caller-controlled string. Without a strict
 * allowlist a caller (or a prompt-injected model turn) could pass
 * `preferredTargetName: "../somewhere"` and escape `targetParent`. The
 * secondary containment check in `materializeSample` catches anything the
 * regex misses.
 */
const SAFE_TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export async function materializeSample(opts: MaterializeOptions): Promise<MaterializeResult> {
  const sampleName = opts.sampleName ?? DEFAULT_SAMPLE_NAME
  const preferredName = opts.preferredTargetName ?? "altimate-sample-dbt"

  // Fail loudly on caller-supplied names that could escape `targetParent` or
  // create surprising layouts (hidden dirs, absolute paths, `..` segments).
  if (!SAFE_TARGET_NAME_RE.test(preferredName)) {
    throw new Error(
      `preferredTargetName '${preferredName}' is not a plain directory name. ` +
        `Expected letters, digits, dot, dash, underscore only; no path separators or leading dot.`,
    )
  }

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

  // Belt-and-suspenders containment check. The name-regex above should already
  // guarantee this, but findSafeTarget also joins a numeric/hex suffix and any
  // future edit to that logic must not sneak the target outside targetParent.
  const resolvedParent = path.resolve(targetParent)
  const resolvedTarget = path.resolve(targetPath)
  if (resolvedTarget !== resolvedParent && !resolvedTarget.startsWith(resolvedParent + path.sep)) {
    throw new Error(
      `refusing to materialize outside targetParent: resolved '${resolvedTarget}' is not under '${resolvedParent}'`,
    )
  }

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

  // Atomic materialize: copy to a staging dir, write the marker there, then
  // rename to the final target. If the process dies mid-copy the user is left
  // with a `.<name>.tmp-<hex>` orphan (harmless — different name; swept below)
  // instead of a partially-written targetPath that would look "unknown" to
  // findSafeTarget on the next run and get shunted into `<name>-2` while the
  // original stays broken forever.
  //
  // For the in-place-upgrade path (state.kind === "our-sample-different-version"
  // + allowInPlaceUpgrade) we still need to overwrite an existing dir; do it
  // by removing the old target AFTER the staging dir is fully written, right
  // before the rename. Users' edits to the sample were already going to be
  // overwritten by this branch; the atomic-vs-non-atomic distinction is
  // "briefly no dir at all" vs "briefly a half-written dir" — atomic wins.

  const stagingName = `.${preferredName}.tmp-${randomBytes(6).toString("hex")}`
  const stagingPath = path.join(targetParent, stagingName)
  // Best-effort cleanup of any prior tmp dirs left over from a killed run.
  sweepOrphanStaging(targetParent, preferredName)
  try {
    copySampleTree(source.path, stagingPath)
    writeMarker(stagingPath, {
      kind: MARKER_KIND,
      sampleName,
      version: opts.sampleVersion,
      materializedAt: new Date().toISOString(),
      cliVersion: opts.cliVersion,
    })
    // Overwrite path: remove the (fully-written-but-outdated) old target so
    // rename can land. Never do this before the staging tree is complete.
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true })
    }
    fs.renameSync(stagingPath, targetPath)
  } catch (err) {
    // Leave the staging dir on error so a debug pass can inspect it, but do
    // not surface a raw ENOENT/EACCES to the caller — repackage.
    throw new Error(
      `materialize failed for ${targetPath} (staging left at ${stagingPath}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return {
    targetPath,
    reused: false,
    suffix,
    note: buildNote(state, targetPath, suffix),
  }
}

/**
 * Delete any `.<preferredName>.tmp-*` directories left over from a prior
 * killed materialize. Best-effort — swallow errors so a permission-denied
 * on one orphan doesn't block a fresh materialize.
 */
function sweepOrphanStaging(targetParent: string, preferredName: string): void {
  const prefix = `.${preferredName}.tmp-`
  let entries: string[]
  try {
    entries = fs.readdirSync(targetParent)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    try {
      fs.rmSync(path.join(targetParent, entry), { recursive: true, force: true })
    } catch {
      // orphan we can't remove — skip, don't fail the fresh materialize
    }
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
