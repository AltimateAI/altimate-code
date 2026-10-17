/**
 * OS confinement for `python_exec`.
 *
 * Analyst Python may read only its session directory, the interpreter installation and
 * the system files an interpreter needs; it may write only its session directory.
 * Subprocesses inherit the same confinement. Where no enforced mechanism exists the tool
 * refuses to run instead of running unconfined.
 *
 * - macOS: `sandbox-exec` profile that denies file reads and writes outside the allowlist,
 *   signals to processes other than itself and its children, network, Apple Events and Mach services outside a small allowlist (LaunchServices could
 *   otherwise start unconfined helper processes).
 * - Linux: `bwrap` with every namespace unshared and only the allowlist mounted. Without a
 *   working `bwrap` the tool refuses. Landlock alone is not used: it does not mediate
 *   `connect()` to pathname Unix sockets (Docker, D-Bus, SSH agent), which can reach host files.
 * - Other platforms: refused.
 *
 * Every mechanism must pass a self-test (a sandboxed interpreter and a subprocess fail to read
 * a canary file outside the allowlist) before it is used.
 */
import { spawn } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export type Filesystem = "sandbox-exec" | "bwrap"
export type Confinement = {
  filesystem: Filesystem
  network: "isolated"
  /** Sandbox executable that wraps the interpreter command. */
  prefix: string[]
  read: ReadAllowlist
}
/**
 * Resolved directories (subpaths) and files the interpreter may read, plus system paths that
 * are symlinks into them (merged-usr `/bin`, `/lib64`), which bwrap recreates as symlinks.
 */
export type ReadAllowlist = { directories: string[]; files: string[]; links: string[] }
export type Detection = { ok: true; confinement: Confinement } | { ok: false; reason: string }

/** Imports that load the native libraries analyst code commonly needs, so their directories are allowlisted. */
const PROBE = `import json, os, site, sys, sysconfig
for name in ("pandas", "duckdb", "numpy", "pyarrow", "ssl", "sqlite3", "decimal", "hashlib", "zlib", "lzma", "bz2", "zoneinfo", "ctypes", "multiprocessing", "subprocess", "csv", "json"):
    try:
        __import__(name)
    except Exception:
        pass
roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, os.path.dirname(os.path.realpath(sys.executable))}
roots.update(site.getsitepackages())
roots.update(value for key, value in sysconfig.get_paths().items() if key in ("stdlib", "platstdlib", "purelib", "platlib"))
libraries = []
if sys.platform == "darwin":
    import ctypes
    dyld = ctypes.CDLL(None)
    dyld._dyld_get_image_name.restype = ctypes.c_char_p
    libraries = [dyld._dyld_get_image_name(i).decode() for i in range(dyld._dyld_image_count())]
elif sys.platform.startswith("linux"):
    with open("/proc/self/maps") as maps:
        libraries = sorted({line.split(None, 5)[5].strip() for line in maps if len(line.split(None, 5)) == 6 and line.split(None, 5)[5].startswith("/")})
print(json.dumps({"roots": sorted(r for r in roots if r), "libraries": libraries}))
`

/** System paths the interpreter needs. Directories are subpaths; the rest are single files. */
const SYSTEM = {
  darwin: {
    directories: [
      "/usr/lib",
      "/usr/share",
      "/System",
      "/bin",
      "/usr/bin",
      "/private/var/db/timezone",
      "/private/var/db/dyld",
    ],
    files: [
      "/",
      "/dev/null",
      "/dev/zero",
      "/dev/random",
      "/dev/urandom",
      "/dev/dtracehelper",
      "/private/etc/localtime",
    ],
  },
  linux: {
    directories: [
      "/usr",
      "/bin",
      "/lib",
      "/lib32",
      "/lib64",
      "/etc/ld.so.conf.d",
      "/etc/alternatives",
      "/sys/devices/system/cpu",
    ],
    files: ["/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/localtime"],
  },
} as const

/** Mach services macOS Python needs; everything else (LaunchServices, Apple Events, ...) is denied. */
const MACH_SERVICES = [
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo",
]

function real(file: string): string | undefined {
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

function within(child: string, parent: string): boolean {
  if (parent === "/") return true
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/")
}

/** Sorted, de-duplicated paths with nested entries removed. */
export function collapse(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b))
  const kept: string[] = []
  for (const p of sorted) if (!kept.some((parent) => within(p, parent))) kept.push(p)
  return kept.sort()
}

/**
 * Read allowlist: interpreter roots, directories of loaded native libraries outside the
 * system directories, and system paths that exist. A root that would expose the filesystem
 * root or the home directory is rejected.
 */
export function readAllowlist(
  platform: NodeJS.Platform,
  probe: { roots: string[]; libraries: string[] },
  options: {
    home?: string
    resolve?: (file: string) => string | undefined
    link?: (file: string) => boolean
  } = {},
): ({ ok: true } & ReadAllowlist) | { ok: false; reason: string } {
  const resolve = options.resolve ?? real
  const link = options.link ?? isLink
  const home = options.home ?? os.homedir()
  const system = platform === "darwin" ? SYSTEM.darwin : SYSTEM.linux
  const systemDirectories = system.directories.flatMap((d) => resolve(d) ?? [])
  const roots = probe.roots.flatMap((r) => resolve(r) ?? [])
  for (const root of roots) {
    if (root === "/" || (home && within(home, root)))
      return {
        ok: false,
        reason: `the Python installation path ${root} would expose the filesystem root or home directory`,
      }
  }
  // Only shared objects and frameworks: never a directory of an arbitrary mapped file (e.g. /dev/shm).
  const library = platform === "darwin" ? /\.(dylib|so)$|\.framework\// : /\.so(\.[0-9]+)*$/
  const libraries = probe.libraries
    .flatMap((lib) => resolve(lib) ?? [])
    .filter((lib) => library.test(lib))
    .filter((lib) => ![...roots, ...systemDirectories].some((dir) => within(lib, dir)))
    .map((lib) => path.dirname(lib))
  for (const dir of libraries) {
    if (dir === "/" || (home && within(home, dir)))
      return {
        ok: false,
        reason: `the native library directory ${dir} would expose the filesystem root or home directory`,
      }
  }
  const files = system.files.filter((f) => f === "/" || resolve(f) !== undefined)
  const directories = collapse([...systemDirectories, ...roots, ...libraries])
  const links = [...system.directories, ...files].filter((p) => p !== "/" && resolve(p) !== undefined && link(p))
  const targets = files.filter((f) => link(f)).flatMap((f) => resolve(f) ?? [])
  return {
    ok: true,
    directories,
    files: [...new Set([...files.filter((f) => !link(f)), ...targets])].filter(
      (f) => f === "/" || !directories.some((dir) => within(f, dir)),
    ),
    links: links.sort(),
  }
}

function quote(p: string): string {
  return `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function ancestors(p: string): string[] {
  const out: string[] = []
  for (let dir = path.dirname(p); ; dir = path.dirname(dir)) {
    out.push(dir)
    if (dir === path.dirname(dir)) return out
  }
}

/** macOS Seatbelt profile: allow-default, then deny reads, writes, network, IPC and signals outside the allowlist. */
export function sandboxProfile(read: ReadAllowlist, write: string[]): string {
  const readable = [
    ...read.directories.map((d) => `(subpath ${quote(d)})`),
    ...read.files.map((f) => `(literal ${quote(f)})`),
    `(regex #"^/dev/tty")`,
    ...write.map((d) => `(subpath ${quote(d)})`),
  ]
  // Path resolution stats each ancestor; metadata reveals no file contents or directory listings.
  const metadata = [
    ...new Set([...read.directories, ...write, "/etc", "/var", "/tmp"].flatMap((p) => [p, ...ancestors(p)])),
  ].map((p) => `(literal ${quote(p)})`)
  const writable = [
    ...write.map((d) => `(subpath ${quote(d)})`),
    `(literal "/dev/null")`,
    `(literal "/dev/dtracehelper")`,
    `(regex #"^/dev/tty")`,
  ]
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny appleevent-send)",
    // Signals reach only the process itself and its own children, never the agent or any other host process.
    "(deny signal)",
    "(allow signal (target self) (target children))",
    `(deny mach-lookup (require-not (require-any ${MACH_SERVICES.map((s) => `(global-name ${quote(s)})`).join(" ")})))`,
    `(deny file-read* (require-not (require-any ${readable.join(" ")})))`,
    `(allow file-read-metadata ${metadata.join(" ")})`,
    `(deny file-write* (require-not (require-any ${writable.join(" ")})))`,
  ].join("\n")
}

/**
 * bubblewrap argv: fresh namespaces (including network and PID), an empty root, read-only binds
 * of the allowlist, symlinks for merged-usr paths, a writable bind of the session directory, and
 * no bind of the host root or home directory.
 */
export function bwrapArgs(
  read: ReadAllowlist,
  write: string[],
  cwd: string,
  options: { readlink?: (p: string) => string } = {},
): string[] {
  const link = options.readlink ?? readlinkSync
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
  args.push("--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc")
  for (const p of [...read.directories, ...read.files].sort()) args.push("--ro-bind", p, p)
  for (const p of read.links) args.push("--symlink", link(p), p)
  for (const d of [...write].sort()) args.push("--bind", d, d)
  args.push("--chdir", cwd)
  return args
}

type Exit = { status: number | null; stdout: string; stderr: string; error?: string }

/** Run a command without blocking the event loop; kill it at the deadline. */
export function execute(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string>; timeout: number },
): Promise<Exit> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    const child = spawn(cmd[0], cmd.slice(1), { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout)
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr, error: e.message })
    })
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function which(name: string): string | undefined {
  return Bun.which(name, { PATH: "/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin" }) ?? Bun.which(name) ?? undefined
}

/** Full argv for a confined interpreter. */
export function launch(input: {
  confinement: Confinement
  write: string[]
  cwd: string
  python: string
  args: string[]
}): string[] {
  const { confinement, write, cwd, python, args } = input
  if (confinement.filesystem === "sandbox-exec")
    return [...confinement.prefix, "-p", sandboxProfile(confinement.read, write), python, "-I", ...args]
  return [...confinement.prefix, ...bwrapArgs(confinement.read, write, cwd), "--", python, "-I", ...args]
}

async function interpreterPaths(python: string, cwd: string, env: Record<string, string>) {
  const result = await execute([python, "-I", "-c", PROBE], { cwd, env, timeout: 20_000 })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout) as { roots: string[]; libraries: string[] }
  } catch {
    return undefined
  }
}

/** Candidate mechanisms for this host, strongest first. */
function candidates(platform: NodeJS.Platform): Omit<Confinement, "read">[] {
  if (platform === "darwin")
    return existsSync("/usr/bin/sandbox-exec")
      ? [{ filesystem: "sandbox-exec", network: "isolated", prefix: ["/usr/bin/sandbox-exec"] }]
      : []
  if (platform !== "linux") return []
  const bwrap = which("bwrap")
  return bwrap ? [{ filesystem: "bwrap", network: "isolated", prefix: [bwrap] }] : []
}

const REFUSAL_TAIL = "Python is never run unconfined."

/** True when the kernel blocks unprivileged user namespaces through AppArmor (Ubuntu 23.10+ default). */
function appArmorRestrictsUserNamespaces(): boolean {
  try {
    return readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1"
  } catch {
    return false
  }
}

/** Refusal text for a host with no working mechanism. Never changes system settings. */
export function unsupported(
  platform: NodeJS.Platform,
  host: { bwrapInstalled?: boolean; appArmorRestricted?: boolean } = {},
): string {
  if (platform !== "linux")
    return `python_exec refused: no filesystem confinement mechanism is supported on ${platform}. Only macOS (sandbox-exec) and Linux (bubblewrap) can confine reads; ${REFUSAL_TAIL}`
  if (!host.bwrapInstalled)
    return `python_exec refused: bubblewrap (\`bwrap\`) is not installed on this Linux host, so no enforced filesystem confinement is available. Install the \`bubblewrap\` package; ${REFUSAL_TAIL}`
  if (host.appArmorRestricted)
    return `python_exec refused: bubblewrap is installed but cannot create a user namespace because the AppArmor setting kernel.apparmor_restrict_unprivileged_userns=1 blocks unprivileged user namespaces. An administrator can either add an AppArmor profile that lets \`bwrap\` create user namespaces, or set the sysctl kernel.apparmor_restrict_unprivileged_userns=0. That is an admin decision; python_exec never changes system settings. ${REFUSAL_TAIL}`
  return `python_exec refused: bubblewrap is installed but cannot create the namespaces it needs on this Linux host. Allow unprivileged user namespaces for \`bwrap\`; ${REFUSAL_TAIL}`
}

/**
 * Pick the strongest working mechanism. A mechanism is accepted only if the sandboxed
 * interpreter can import pandas and duckdb and read its own directory, while both Python and a
 * `cat` subprocess fail to read a canary file outside the allowlist.
 */
export async function detectConfinement(input: {
  python: string
  /** Bootstrap that wraps analyst code; the self-test runs through it exactly as calls do. */
  bootstrap: string
  env: (workdir: string) => Record<string, string>
  platform?: NodeJS.Platform
  /** Override the host's candidate mechanisms (tests). */
  mechanisms?: Omit<Confinement, "read">[]
  /** Override the AppArmor user-namespace restriction probe (tests). */
  appArmorRestricted?: () => boolean
}): Promise<Detection> {
  const platform = input.platform ?? process.platform
  const options = input.mechanisms ?? candidates(platform)
  const refusal = () =>
    unsupported(platform, {
      bwrapInstalled: options.some((o) => o.filesystem === "bwrap"),
      appArmorRestricted: platform === "linux" && (input.appArmorRestricted ?? appArmorRestrictsUserNamespaces)(),
    })
  if (!options.length)
    return {
      ok: false,
      reason:
        platform === "darwin"
          ? `python_exec refused: sandbox-exec not found at /usr/bin/sandbox-exec, so no enforced filesystem confinement is available. ${REFUSAL_TAIL}`
          : refusal(),
    }
  const work = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "altimate-python-sandbox-")))
  const elsewhere = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "altimate-python-canary-")))
  try {
    const paths = await interpreterPaths(input.python, work, input.env(work))
    if (!paths)
      return {
        ok: false,
        reason: "python_exec refused: could not inspect the Python installation to build its read allowlist.",
      }
    const allow = readAllowlist(platform, paths)
    if (!allow.ok) return { ok: false, reason: `python_exec refused: ${allow.reason}.` }
    const canary = path.join(elsewhere, "canary.txt")
    const inside = path.join(work, "inside.txt")
    await fs.writeFile(canary, "outside")
    await fs.writeFile(inside, "inside")
    await fs.mkdir(path.join(work, "tmp"))
    const cell = path.join(work, "selftest.py")
    await fs.writeFile(
      cell,
      [
        "import duckdb, pandas, subprocess",
        `assert open(${JSON.stringify(inside)}).read() == "inside"`,
        `assert subprocess.run(["cat", ${JSON.stringify(inside)}], capture_output=True).stdout == b"inside"`,
        "try:",
        `    open(${JSON.stringify(canary)}).read()`,
        "    print('PYTHON_LEAK')",
        "except OSError:",
        "    print('PYTHON_CONFINED')",
        `result = subprocess.run(["cat", ${JSON.stringify(canary)}], capture_output=True)`,
        "print('SUBPROCESS_CONFINED' if result.returncode != 0 and b'outside' not in result.stdout else 'SUBPROCESS_LEAK')",
      ].join("\n"),
    )
    const bootstrap = path.join(work, "_bootstrap.py")
    await fs.writeFile(bootstrap, input.bootstrap)
    const failures: string[] = []
    for (const option of options) {
      const confinement: Confinement = {
        ...option,
        read: { directories: allow.directories, files: allow.files, links: allow.links },
      }
      const argv = launch({
        confinement,
        write: [work],
        cwd: work,
        python: input.python,
        args: [bootstrap, cell, work],
      })
      const result = await execute(argv, { cwd: work, env: input.env(work), timeout: 30_000 })
      const out = result.stdout
      if (
        result.status === 0 &&
        out.includes("PYTHON_CONFINED") &&
        out.includes("SUBPROCESS_CONFINED") &&
        !out.includes("LEAK")
      )
        return { ok: true, confinement }
      failures.push(
        `${option.filesystem}: ${(result.stderr || out || result.error || "no output").trim().split("\n").slice(-1)[0]}`,
      )
    }
    if (platform === "darwin")
      return {
        ok: false,
        reason: `python_exec refused: sandbox-exec self-test failed: ${failures.join("; ")}. ${REFUSAL_TAIL}`,
      }
    return { ok: false, reason: `${refusal()} Self-test results: ${failures.join("; ")}` }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
    await fs.rm(elsewhere, { recursive: true, force: true })
  }
}
