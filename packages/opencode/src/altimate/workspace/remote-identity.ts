// altimate_change - new file
//
// Which project a git remote names, by the workspace service's rule.
//
// The service stores one value per repo on github.com, gitlab.com and
// bitbucket.org: `https://<host>/<path>`, whatever URL form the clone used.
// Bindings linked before it did keep the form they were linked with
// (`ssh://git@github.com/acme/x`), and the service may rewrite them to the
// https value later. A client that compares remotes as raw strings then sees
// one repo as two: memory records written under the old value stop matching
// the binding, and the link dialog reports drift for a remote that has not
// changed.
//
// `canonicalRepoRemote` and `unifyPublicHost` port the service's two steps
// line for line, including where Python's string and URL parsing differ from
// JavaScript's; test/altimate/workspace/fixtures/remote-identity-vectors.json
// holds the service's own output, under the Python version it runs (3.10.22),
// for every case the tests check.

const IDENTIFIER_MAX_LENGTH = 2048

// Hosts whose repository paths are case-insensitive, and where every URL form
// of a repo names the same repo.
const CASE_INSENSITIVE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"])

const REMOTE_SCHEMES = new Set(["https", "http", "ssh", "git", "git+ssh", "ssh+git"])
const SSH_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git"])
const WEB_SCHEMES = new Set(["https", "http"])

// Other hostnames that reach the same repos: the SSH-over-443 hosts serve only
// SSH, the `www.` hosts only the web schemes.
const SSH_HOST_ALIASES: Record<string, string> = {
  "ssh.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com",
  "altssh.bitbucket.org": "bitbucket.org",
}
const WEB_HOST_ALIASES: Record<string, string> = {
  "www.github.com": "github.com",
  "www.gitlab.com": "gitlab.com",
  "www.bitbucket.org": "bitbucket.org",
}

// Python's `str.strip()` set (`str.isspace`). JavaScript's `trim()` differs:
// it also strips U+FEFF and keeps U+001C-U+001F and U+0085.
const PY_WHITESPACE = new Set(
  "\t\n\u000b\u000c\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000",
)

function pyStrip(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && PY_WHITESPACE.has(s[start])) start++
  while (end > start && PY_WHITESPACE.has(s[end - 1])) end--
  return s.slice(start, end)
}

function stripChar(s: string, ch: string, side: "left" | "right" | "both"): string {
  let start = 0
  let end = s.length
  if (side !== "right") while (start < end && s[start] === ch) start++
  if (side !== "left") while (end > start && s[end - 1] === ch) end--
  return s.slice(start, end)
}

function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep)
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)]
}

function rpartition(s: string, sep: string): [string, string, string] {
  const i = s.lastIndexOf(sep)
  return i < 0 ? ["", "", s] : [s.slice(0, i), sep, s.slice(i + sep.length)]
}

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s)

/** The service's canonical form of a remote: credentials (other than an SSH
 * `git@` user) dropped, host lowercased, the path lowercased on the
 * case-insensitive hosts, one trailing `.git` and trailing slashes removed,
 * and scp-like `git@host:org/repo` written as `ssh://git@host/org/repo`. */
export function canonicalRepoRemote(value: string): string {
  let v = pyStrip(value)
  if (!v) return v

  if (!v.includes("://") && v.includes("@") && partition(v, "@")[2].includes(":")) {
    const [userHost, , path] = partition(v, ":")
    v = `ssh://${userHost}/${stripChar(path, "/", "left")}`
  }

  let scheme = ""
  let rest = v
  if (rest.includes("://")) [scheme, , rest] = partition(rest, "://")

  if (rest.includes("@")) {
    const [creds, , hostAndPath] = rpartition(rest, "@")
    rest = creds === "git" ? `git@${hostAndPath}` : hostAndPath
  }

  let hostPart: string
  let pathPart: string
  if (rest.includes("/")) [hostPart, , pathPart] = partition(rest, "/")
  else [hostPart, pathPart] = [rest, ""]

  let userPrefix = ""
  let host = hostPart
  if (host.startsWith("git@")) {
    userPrefix = "git@"
    host = host.slice("git@".length)
  }
  host = host.toLowerCase()
  const fullHost = `${userPrefix}${host}`

  pathPart = stripChar(pathPart, "/", "right")
  if (pathPart.endsWith(".git")) pathPart = pathPart.slice(0, -".git".length)
  pathPart = stripChar(pathPart, "/", "right")

  if (CASE_INSENSITIVE_HOSTS.has(host)) pathPart = pathPart.toLowerCase()

  const base = scheme ? `${scheme}://${fullHost}` : fullHost
  return pathPart ? `${base}/${pathPart}` : base
}

/** The lowercased host of a URL's `user@host:port`, or null when that isn't one
 * host with an optional numeric port: the service's `_authority_host`, which
 * reads it through Python's `urlsplit`.
 *
 * urlsplit drops tab, CR and LF and ends the authority at `?` or `#`, so the
 * service refuses an authority holding any of them. A bracketed authority is
 * refused too: urlsplit accepts only an IP address there, which is never one of
 * the hosts `unifyPublicHost` rewrites, so the result is the same. */
function authorityHost(authority: string): string | null {
  if (/[\t\r\n?#[\]]/.test(authority)) return null
  // A non-ASCII authority whose NFKC form introduces a URL delimiter is refused.
  if (!isAscii(authority)) {
    const n = authority.replace(/[@:#?]/g, "")
    const normalized = n.normalize("NFKC")
    if (n !== normalized && /[/?#@:]/.test(normalized)) return null
  }
  const [hostname, , portText] = partition(rpartition(authority, "@")[2], ":")
  let port: number | undefined
  if (portText) {
    if (!/^[0-9]+$/.test(portText)) return null
    port = Number(portText)
    if (port > 65535) return null
  }
  const badPort = port === undefined ? authority.endsWith(":") : port === 0 || !authority.endsWith(`:${port}`)
  if (badPort) return null
  return hostname.toLowerCase()
}

/** `https://<host>/<path>` for a repo on github.com, gitlab.com or
 * bitbucket.org, whatever URL form `canonical` is in; otherwise `canonical`
 * unchanged. `canonical` is a `canonicalRepoRemote` value: the service's
 * `_unify_public_host`. */
export function unifyPublicHost(canonical: string): string {
  let [scheme, sep, rest] = partition(canonical, "://")
  let host: string
  let path: string
  if (sep) {
    scheme = scheme.toLowerCase()
    if (!REMOTE_SCHEMES.has(scheme)) return canonical
    let authority: string
    ;[authority, , path] = partition(rest, "/")
    const parsed = authorityHost(authority)
    if (parsed === null) return canonical
    host = parsed
  } else {
    // scp-like `host:path` with no user. Git reads a value as scp-like only
    // when no `/` precedes the first `:`; anything else is a local path.
    const [authority, colon, after] = partition(canonical, ":")
    if (!colon || authority.includes("/")) return canonical
    scheme = "ssh"
    host = rpartition(authority, "@")[2].toLowerCase()
    path = after
  }
  if (SSH_SCHEMES.has(scheme)) host = SSH_HOST_ALIASES[host] ?? host
  else if (WEB_SCHEMES.has(scheme)) host = WEB_HOST_ALIASES[host] ?? host
  if (!CASE_INSENSITIVE_HOSTS.has(host) || !isAscii(path)) return canonical
  path = stripChar(path, "/", "both").toLowerCase()
  const unified = `https://${host}/${path}`
  if (!path || new TextEncoder().encode(unified).length > IDENTIFIER_MAX_LENGTH) return canonical
  return unified
}

/** The value two remotes of one repo share: the service's unified value of the
 * remote's canonical form, applied until it stops changing.
 *
 * Inputs come in three shapes: a remote as git prints it, a value the service
 * stored (canonical, or unified), and a raw remote the client cached before
 * the service answered. One pass maps all of them to the service's value,
 * except where a pass is not idempotent: canonicalization takes one trailing
 * `.git` off a stored value that still ends in one. Repeating reaches the same
 * value from every shape. The cost is that a repo whose name ends in `.git`
 * compares equal to the one without it; the service already stores several
 * forms of such a repo under the shorter name. */
export function repoRemoteKey(value: string): string {
  // Only the first pass can lengthen the value (`git@` to `ssh://git@`, `http`
  // to `https`). Every later pass that changes it removes at least one
  // character, so the value settles within this bound.
  const bound = value.length + 16
  let key = value
  for (let i = 0; i < bound; i++) {
    const next = unifyPublicHost(canonicalRepoRemote(key))
    if (next === key) break
    key = next
  }
  return key
}

export function sameRepoRemote(a: string, b: string): boolean {
  return a === b || repoRemoteKey(a) === repoRemoteKey(b)
}

/** A project's identity as the binding system records it: its git remote when
 * it has one, otherwise its path. */
export type ProjectIdentity = { kind: "remote" | "path"; value: string }

/** The identity a remote/path pair names, preferring the remote, as both the
 * binding cache and memory record metadata do. Non-string values are absent. */
export function projectIdentity(remote: unknown, projectPath: unknown): ProjectIdentity | undefined {
  if (typeof remote === "string") return { kind: "remote", value: remote }
  if (typeof projectPath === "string") return { kind: "path", value: projectPath }
  return undefined
}

/** Do two identities name the same project? Remotes compare by
 * `repoRemoteKey`; paths compare exactly, since a path is never a remote and
 * must not be rewritten (`/srv/x.git`, `C:\x.git`); a remote never equals a
 * path. A missing identity matches nothing. */
export function sameProjectIdentity(a: ProjectIdentity | undefined, b: ProjectIdentity | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === "remote" ? sameRepoRemote(a.value, b.value) : a.value === b.value
}

/** Does the identifier a binding was found by still name this project? `kind`
 * is which identifier matched; `stored` is the binding's value, from the
 * service or the local cache, and `current` is this project's, with the remote
 * as git prints it (`git@github.com:acme/x.git`). */
export function sameIdentifier(kind: "remote" | "path", stored: string, current: string): boolean {
  return kind === "remote" ? sameRepoRemote(stored, current) : stored === current
}
