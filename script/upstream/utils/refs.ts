// Shared ref-resolution and object-database read helpers for census.ts,
// divergence.ts, and replay.ts.
//
// Ground rule (binding, from the de-fork spike spec): these tools NEVER touch
// the network. If a ref (typically an upstream release tag like v1.18.3)
// isn't available locally, we fail with the exact fetch command the operator
// needs to run — we do not fetch it for them.
//
// Security rule (binding): every git invocation here uses spawnSync with an
// argv array, never a shell-interpolated command string. A ref name flowing
// through `execSync(\`git ... "${ref}"\`)` is shell-injectable even inside
// double quotes (`$(...)`  and backticks still expand) — refs can originate
// from CLI flags, so this is a real attack surface, not a theoretical one.

import { spawnSync } from "child_process"

export interface ResolvedRef {
  ref: string
  sha: string
  tree: string
}

/** Run `git <args>` and return trimmed stdout, or null on any non-zero exit / spawn failure. */
function run(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 })
  if (result.error || result.status !== 0) return null
  return result.stdout.trim()
}

/** Run `git <args>` and return raw stdout as a Buffer, throwing on failure. Used for binary-safe / NUL-delimited reads.
 * Exported so divergence.ts / replay.ts run all git the same arg-vector (never shell-interpolated) way. */
export function runGitBufferOrThrow(args: string[], cwd: string, opts: { input?: string | Buffer; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 200 * 1024 * 1024,
    env: opts.env ?? process.env,
  })
  if (result.error) {
    throw new Error(`Failed to spawn 'git ${args.join(" ")}': ${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf-8") : ""
    throw new Error(`'git ${args.join(" ")}' exited ${result.status}: ${stderr}`)
  }
  return result.stdout as Buffer
}

/**
 * Resolve a ref to its commit SHA and root tree SHA, entirely from local
 * refs/objects. Throws with exact fetch instructions if the ref is missing.
 * `remoteHint` (default "upstream") is used to compose the suggested command;
 * pass the literal remote name the ref is expected to come from.
 */
export function resolveRefOrThrow(ref: string, repoRoot: string, remoteHint = "upstream"): ResolvedRef {
  const sha = run(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot)
  if (!sha) {
    throw new Error(
      `Ref '${ref}' was not found locally, and this tool never fetches over the network.\n` +
        `If '${ref}' is an upstream release tag, fetch it first:\n` +
        `  git fetch ${remoteHint} tag ${ref} --no-tags\n` +
        `If it's a branch, a plain fetch only updates the remote-tracking ref\n` +
        `'${remoteHint}/${ref}' (not a local '${ref}'), so fetch and then re-run against that:\n` +
        `  git fetch ${remoteHint} ${ref}\n` +
        `  # then re-run this command using '${remoteHint}/${ref}' in place of '${ref}'\n` +
        `(or fetch into a local ref explicitly: git fetch ${remoteHint} ${ref}:${ref}).`,
    )
  }
  const tree = run(["rev-parse", "--verify", `${ref}^{tree}`], repoRoot)
  if (!tree) {
    throw new Error(`Ref '${ref}' resolved to commit ${sha} but its tree could not be resolved. Repository object database may be corrupt.`)
  }
  return { ref, sha, tree }
}

/**
 * Load the full set of blob paths tracked at a given tree-ish, as they'd
 * appear relative to the repo root. Used to test upstream_shared membership.
 * NUL-delimited (`-z`) so paths containing newlines/spaces/unusual bytes are
 * never mis-split.
 */
export function loadPathsAtRef(ref: string, repoRoot: string): Set<string> {
  const buf = runGitBufferOrThrow(["ls-tree", "-r", "-z", "--name-only", ref], repoRoot)
  const set = new Set<string>()
  for (const rec of buf.toString("utf-8").split("\0")) {
    if (rec.length > 0) set.add(rec)
  }
  return set
}

export interface TreeEntry {
  mode: string
  type: string
  oid: string
  path: string
}

/**
 * List every entry (blobs and subtrees pre-expanded via `-r`) at a tree-ish,
 * via `git ls-tree -r -z`. NUL-delimited so this is safe for any path byte
 * sequence git allows. This is the tree-based replacement for walking the
 * working filesystem: it reads exactly what's committed at `ref`, regardless
 * of untracked files sitting in the working tree or files excluded by
 * .gitignore.
 */
export function listTreeEntries(ref: string, repoRoot: string): TreeEntry[] {
  const buf = runGitBufferOrThrow(["ls-tree", "-r", "-z", ref], repoRoot)
  const entries: TreeEntry[] = []
  for (const rec of buf.toString("utf-8").split("\0")) {
    if (rec.length === 0) continue
    // format: "<mode> <type> <oid>\t<path>"
    const tab = rec.indexOf("\t")
    if (tab === -1) continue
    const meta = rec.slice(0, tab).split(" ")
    const [mode, type, oid] = meta
    entries.push({ mode, type, oid, path: rec.slice(tab + 1) })
  }
  return entries
}

/**
 * Batch-read blob contents for a set of OIDs via a single `git cat-file
 * --batch` process (fed all OIDs on stdin) instead of one `git show`/`git
 * cat-file` invocation per file — this is what makes tree-based reads of a
 * multi-thousand-file corpus fast. Returns a Map from oid to UTF-8 content.
 *
 * Duplicate oids in the input are only read once from git but present in the
 * returned map for each requested oid (trivially true since the map is keyed
 * by oid).
 */
export function readBlobsBatch(oids: string[], repoRoot: string): Map<string, string> {
  const map = new Map<string, string>()
  if (oids.length === 0) return map

  // Dedup the INPUT so git emits exactly one record per unique oid. Feeding a
  // duplicate oid makes `cat-file --batch` emit its record twice; skipping the
  // second on the read side (without consuming its bytes) would desync `offset`
  // and silently corrupt every subsequent object. Reading unique oids keeps the
  // output-stream cursor exactly aligned with the loop.
  const uniqueOids = [...new Set(oids)]

  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: uniqueOids.join("\n") + "\n",
    maxBuffer: 500 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(`Failed to spawn 'git cat-file --batch': ${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf-8") : ""
    throw new Error(`'git cat-file --batch' exited ${result.status}: ${stderr}`)
  }
  const buf: Buffer = result.stdout
  const NL = 0x0a
  let offset = 0
  for (const oid of uniqueOids) {
    const nlIdx = buf.indexOf(NL, offset)
    if (nlIdx === -1) {
      throw new Error(`git cat-file --batch: unexpected end of output while reading header for ${oid}`)
    }
    const header = buf.slice(offset, nlIdx).toString("utf-8")
    offset = nlIdx + 1
    const headerMatch = header.match(/^([0-9a-f]+) (\S+) (\d+)$/)
    if (!headerMatch) {
      throw new Error(`git cat-file --batch: object ${oid} not found or malformed header: '${header}'`)
    }
    const size = Number(headerMatch[3])
    const content = buf.slice(offset, offset + size)
    offset += size + 1 // skip the single trailing newline git appends after each object's content
    map.set(oid, content.toString("utf-8"))
  }
  return map
}

/** Get the local git version as [major, minor, patch]. */
export function gitVersion(repoRoot: string): [number, number, number] {
  const out = run(["--version"], repoRoot) ?? ""
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`Could not parse 'git --version' output: '${out}'`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Compare two [major, minor, patch] tuples. Returns -1, 0, or 1. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}
