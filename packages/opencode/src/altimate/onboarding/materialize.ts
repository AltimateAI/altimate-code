import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { MARKER_KIND, checkParentWritable, classifyTarget, findSafeTarget, writeMarker, type TargetState } from "./marker"
import { DEFAULT_SAMPLE_NAME, loadShippedManifest, resolveSampleSource, type SampleSourceLocation } from "./sample-source-resolver"

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
const MATERIALIZE_ENTRIES: ReadonlyArray<{ from: string; kind: "file" | "dir"; required: boolean }> = [
  { from: "README.md", kind: "file", required: true },
  { from: "dbt_project.yml", kind: "file", required: true },
  { from: "profiles.yml", kind: "file", required: true },
  { from: "sample-manifest.json", kind: "file", required: true },
  // .gitignore is the ONLY optional entry — dev checkouts may lack it and
  // materialize should not fail. Every other entry is load-bearing for
  // /discover, /review, or the "Build & query it" flow; missing any of
  // them means a broken package and we must fail loudly rather than mark
  // the incomplete copy as reused-forever.
  { from: ".gitignore", kind: "file", required: false },
  { from: "models", kind: "dir", required: true },
  { from: "seeds", kind: "dir", required: true },
  { from: "target/manifest.json", kind: "file", required: true },
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
  /** If true, the finder skips a version-mismatched slot 0 and materializes
   *  into slot 1 (`<preferredName>-2`), leaving the older version in place.
   *  This is the "install alongside" upgrade path — the user gets the new
   *  version to try without losing their old copy or its edits. Overrides
   *  `allowInPlaceUpgrade` when both are set (alongside is less destructive). */
  installAlongside?: boolean
  /** Escape hatch for internal callers (e.g. tests) that need to materialize
   *  under a path `rejectUnsafeHome` would ordinarily block (`/tmp/*`).
   *  NEVER exposed on the LLM-facing tool schema — a prompt-injected model
   *  turn must not be able to escape the safe-parent check by setting a
   *  flag. Leave false unless you have a specific reason. */
  allowUnsafeParent?: boolean
  /** Optionally pass an ALREADY-RESOLVED sample source to skip the internal
   *  `resolveSampleSource` sweep. sample_setup.ts resolves once at the top
   *  of `execute()` so the manifest read and the materialize copy share the
   *  same source; if you pass this, materializeSample uses it verbatim
   *  instead of running the candidate hunt a second time. */
  preResolvedSource?: SampleSourceLocation
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
 * - `os.tmpdir()` and its subdirs — macOS `/var/folders/…`, Windows
 *   `%TEMP%`; same "gone on reboot" issue as `/tmp` but the paths look
 *   like real homes at a glance.
 * - Windows system dirs — `%SYSTEMROOT%`, `%PROGRAMFILES%`.
 * - unset — leave to the caller.
 */
export function rejectUnsafeHome(home: string | undefined): string | undefined {
  if (!home) return "HOME environment variable is not set"
  if (home === "/" || home === "") return `HOME='${home}' is not a usable directory`
  if (home === "/root" && process.getuid?.() !== 0) {
    return "HOME=/root but this process is not running as root (likely `sudo npm install -g` — the sample would materialize into root's home and be invisible from your normal shell). Re-run without sudo, or pass an explicit `--target-parent`."
  }
  // Canonicalize BOTH sides of the tmp comparison before matching —
  // otherwise a caller who passes `/private/tmp/foo` on macOS bypasses
  // the `/tmp/*` check (because `/tmp` is a symlink to `/private/tmp`,
  // so the raw string comparison sees no shared prefix) and the
  // `os.tmpdir()` check (macOS reports `/var/folders/…` while realpath
  // of the same tmpdir returns `/private/var/folders/…`). A codex sweep
  // of this class flagged the raw comparison as a bypass. realpathSync
  // fails on nonexistent paths — fall back to `path.resolve` so the
  // check still handles relative parents like `./tmp`.
  const canonicalize = (p: string): string => {
    try { return fs.realpathSync(p) } catch { return path.resolve(p) }
  }
  const canonicalHome = canonicalize(home)
  // Hoist references OUT of check() — realpathSync is a syscall on each
  // call, and check() runs up to twice per invocation (once against the
  // canonical home, once against the raw home). Neither ref depends on
  // the candidate, so compute them once here. Some references (like the
  // string literal "/tmp") can't always be realpathed as a directory,
  // so we include them raw; the canonical versions catch the
  // /private/tmp and /private/var/folders/... bypasses.
  const refs: string[] = ["/tmp", canonicalize("/tmp"), os.tmpdir(), canonicalize(os.tmpdir())]
  const check = (candidate: string): string | undefined => {
    for (const ref of refs) {
      if (!ref) continue
      if (candidate === ref || candidate.startsWith(ref + path.sep)) {
        return `HOME='${home}' resolves to '${candidate}' which is under an ephemeral system tmp path (${ref}) — the sample would be hard to find or swept by tmp-cleanup jobs. Pass an explicit --target-parent to override.`
      }
    }
    return undefined
  }
  // Check canonical form first (catches the bypasses above); then the
  // raw literal for a redundant check against the caller's input.
  const canonicalReject = check(canonicalHome)
  if (canonicalReject) return canonicalReject
  if (canonicalHome !== home) {
    const rawReject = check(home)
    if (rawReject) return rawReject
  }
  // Windows-specific system paths. Cheap conservative checks — we're not
  // trying to enumerate every dangerous Windows dir, just the two an
  // installer would most obviously misconfigure to.
  if (process.platform === "win32") {
    const systemRoot = process.env["SYSTEMROOT"] || process.env["WINDIR"] // e.g. C:\Windows
    if (systemRoot) {
      const normHome = home.toLowerCase()
      const normSys = systemRoot.toLowerCase()
      if (normHome === normSys || normHome.startsWith(normSys + path.sep)) {
        return `HOME='${home}' is under the Windows system directory (${systemRoot}) — refusing to write there. Set HOME to a real user profile before materializing.`
      }
    }
    const programFiles = process.env["PROGRAMFILES"]
    if (programFiles) {
      const normHome = home.toLowerCase()
      const normPF = programFiles.toLowerCase()
      if (normHome === normPF || normHome.startsWith(normPF + path.sep)) {
        return `HOME='${home}' is under Program Files (${programFiles}) — refusing to write there. Set HOME to a real user profile before materializing.`
      }
    }
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
  // rejectUnsafeHome applies to ANY targetParent, not just the defaulted-from-HOME
  // one. A prompt-injected model turn (or a misconfigured caller) that passes
  // targetParent: "/root" or "/tmp/x" must be refused; the guard exists to
  // prevent materializing sample projects somewhere the user won't find them
  // (or would be surprised by), and the risk is orthogonal to whether HOME
  // itself is safe. If the caller genuinely wants to install under an unsafe
  // path they can pass `allowUnsafeParent: true` — that's an internal option
  // never exposed on the LLM-facing tool schema.
  if (!opts.allowUnsafeParent) {
    const parentReject = rejectUnsafeHome(targetParent)
    if (parentReject) {
      throw new Error(parentReject)
    }
  }

  // Fail loudly on unwritable parents (read-only home, NFS glitch, container
  // mount) BEFORE we start hunting candidate names — gives the caller a
  // clean error instead of a raw EACCES from mkdirSync mid-copy.
  const writableError = checkParentWritable(targetParent)
  if (writableError) {
    throw new Error(writableError)
  }

  const source = opts.preResolvedSource ?? resolveSampleSource(sampleName)
  if (!source) {
    throw new Error(
      `Could not locate the starter sample source ('${sampleName}'). This usually means the CLI was installed without its wrapper package assets. Reinstall with: npm i -g @altimateai/altimate-code@latest`,
    )
  }

  // Everything below — slot classification, staging copy, marker write, and
  // atomic rename — happens under a Flock keyed on the parent + preferred
  // name. Concurrent materialize() calls with the same preferredName under
  // the same parent are serialized; different names or different parents
  // never block each other. Without this lock, two callers could both see
  // slot 0 as empty (or as our-sample-different-version + allowInPlaceUpgrade)
  // and race, with the second's rename either failing or silently clobbering
  // the first's completed materialize.
  const lockKey = `altimate-onboarding:materialize:${path.resolve(targetParent)}:${preferredName}`
  return await Flock.withLock(lockKey, async () => {
    return await materializeUnderLock(opts, sampleName, preferredName, targetParent, source.path)
  })
}

async function materializeUnderLock(
  opts: MaterializeOptions,
  sampleName: string,
  preferredName: string,
  targetParent: string,
  sourcePath: string,
): Promise<MaterializeResult> {
  const { path: targetPath, state, suffix } = findSafeTarget(
    targetParent,
    preferredName,
    opts.sampleVersion,
    sampleName,
    100,
    { skipVersionMismatch: opts.installAlongside === true },
  )

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
  // with a `.<name>.tmp-<hex>` orphan (harmless — different name; swept below
  // with an age guard so we never nuke a live sibling) instead of a
  // partially-written targetPath that would look "unknown" to findSafeTarget
  // on the next run and get shunted into `<name>-2` while the original stays
  // broken forever.
  const stagingName = `.${preferredName}.tmp-${randomBytes(6).toString("hex")}`
  const stagingPath = path.join(targetParent, stagingName)
  // Best-effort cleanup of any prior tmp dirs older than ORPHAN_AGE_MS —
  // Flock serializes same-preferredName runs, but a killed run with the
  // same name could still have left a stale staging dir. We refuse to touch
  // recently-mtimed entries defensively (in case a caller invoked
  // materializeSample from a different process without going through the
  // usual lock path).
  sweepOrphanStaging(targetParent, preferredName)
  try {
    // Write to staging, but bake the FINAL target path into path-carrying
    // files (target/manifest.json rehydration) — the atomic rename will
    // land the tree at `targetPath`, so any path field written now with
    // the staging path would be stale after the rename.
    copySampleTree(sourcePath, stagingPath, targetPath)
    writeMarker(stagingPath, {
      kind: MARKER_KIND,
      sampleName,
      version: opts.sampleVersion,
      materializedAt: new Date().toISOString(),
      cliVersion: opts.cliVersion,
    })

    // Overwrite path: if there's an existing dir at targetPath, RE-VERIFY
    // it still looks like the same version-mismatched sample we saw at
    // findSafeTarget time before removing it. Even under the lock, another
    // process could have written to that path between findSafeTarget and
    // now (a manual `mv`, a second altimate-code install writing without
    // the lock, etc.); a stale classification must not authorize a
    // destructive remove.
    if (fs.existsSync(targetPath)) {
      const nowState = classifyTarget(targetPath, opts.sampleVersion, sampleName)
      const stillEligible =
        (state.kind === "our-sample-different-version" && nowState.kind === "our-sample-different-version") ||
        (state.kind === "empty" && nowState.kind === "empty")
      if (!stillEligible) {
        throw new Error(
          `targetPath ${targetPath} was classified as ${state.kind} but is now ${nowState.kind} — refusing to remove. Rerun materializeSample to re-select a safe target.`,
        )
      }
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
 * Delete `.<preferredName>.tmp-*` staging directories left over from a
 * killed materialize — but ONLY those older than `ORPHAN_MAX_AGE_MS`. The
 * age gate matters: a stale-classification-based sweep could otherwise
 * delete a live staging dir a concurrent process (running outside our
 * Flock, e.g. a different CLI version, or a script that bypassed the tool
 * boundary) is still writing into.
 *
 * Best-effort — swallow errors so a permission-denied on one orphan
 * doesn't block a fresh materialize.
 */
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour — well past any real materialize wall-time

function sweepOrphanStaging(targetParent: string, preferredName: string): void {
  const prefix = `.${preferredName}.tmp-`
  let entries: string[]
  try {
    entries = fs.readdirSync(targetParent)
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const entryPath = path.join(targetParent, entry)
    try {
      // lstatSync (not statSync) so a symlinked entry has ITS OWN age
      // checked, not the age of whatever it points at. If a user drops
      // `.<name>.tmp-abc123 -> /some/frequently-touched/dir` into the
      // parent, statSync would follow the link and return the target's
      // mtime; the age guard would pass on a symlink that's actually
      // ancient and we'd rmSync it (Node removes the symlink itself,
      // not the target, but the classification is still wrong). Skip
      // symlinks entirely — a symlink can't be a stale staging tree we
      // wrote, so we have no business garbage-collecting it. Same
      // class as finding 21 / codex NEW-5.
      const stat = fs.lstatSync(entryPath)
      if (stat.isSymbolicLink()) continue
      const ageMs = now - Math.max(stat.mtimeMs, stat.birthtimeMs || 0)
      if (ageMs < ORPHAN_MAX_AGE_MS) continue // young — could be a live sibling
      fs.rmSync(entryPath, { recursive: true, force: true })
    } catch {
      // orphan we can't stat/remove — skip, don't fail the fresh materialize
    }
  }
}

/**
 * Copy the shipped sample tree from `source` into `writeTo`. `finalTarget`
 * is where the tree will END UP after atomic-rename (writeTo is the
 * staging dir; finalTarget is the user-visible path). The distinction
 * only matters for files that bake absolute paths into their bytes —
 * currently just `target/manifest.json`, which carries {{SAMPLE_ROOT}}
 * sentinels that must be rehydrated to `finalTarget`, not `writeTo`,
 * or the rename will invalidate every path the manifest embeds.
 */
function copySampleTree(source: string, writeTo: string, finalTarget: string): void {
  fs.mkdirSync(writeTo, { recursive: true })
  for (const entry of MATERIALIZE_ENTRIES) {
    const from = path.join(source, entry.from)
    const to = path.join(writeTo, entry.from)
    if (!fs.existsSync(from)) {
      // Optional entries (currently just .gitignore) skip quietly. Required
      // entries mean the shipped package is broken — surface that as an
      // error before writing a marker that would falsely mark this
      // incomplete copy as reused-forever on subsequent runs.
      if (entry.required) {
        throw new Error(
          `Sample source at ${source} is missing required entry '${entry.from}' — ` +
            `the shipped package is incomplete. Reinstall with: npm i -g @altimateai/altimate-code@latest`,
        )
      }
      continue
    }
    if (entry.kind === "dir") {
      fs.cpSync(from, to, { recursive: true, force: true })
    } else if (entry.from === "target/manifest.json") {
      // Special-case the pre-compiled dbt manifest: the shipped file carries
      // {{SAMPLE_ROOT}} / {{SAMPLE_ROOT_PARENT}} sentinels in every path
      // field (root_path, patch_path, original_file_path, …) so the same
      // committed artifact works for every user regardless of where they
      // materialize the sample. Copy-by-bytes would ship those sentinels
      // as-is and /discover + /review would choke on paths starting with
      // "{{SAMPLE_ROOT}}/models/staging/stg_customers.sql". Route through
      // loadShippedManifest which rehydrates the sentinels — REHYDRATED
      // TO finalTarget (not writeTo) because atomic-rename will move
      // this file to finalTarget after we return.
      const rehydrated = loadShippedManifest(source, finalTarget)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.writeFileSync(to, JSON.stringify(rehydrated, null, 2) + "\n", "utf8")
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
