import { $ } from "bun"
import semver from "semver"
import path from "path"
import { resolveChannel } from "./channel"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
  OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
}
const CHANNEL = await (async () => {
  // altimate_change — see ./channel.ts for why this is a separate pure function. (#1233)
  const resolved = resolveChannel(env)
  if (resolved) return resolved
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION.replace(/^v/, "")
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  // altimate_change start — upstream_fix: derive the next version from the FORK's published package,
  // not upstream's `opencode-ai`. Upstream is on 1.17.x; deriving from it would bump a fork release to
  // ~1.18.0 instead of 0.x. That inverts version ordering: existing users auto-upgrade to the bogus
  // high version, then can never auto-upgrade to the real fix (a lower 0.x is treated as a downgrade).
  const version = await fetch("https://registry.npmjs.org/@altimateai/altimate-code/latest")
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data.version)
  // altimate_change end
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.OPENCODE_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

// altimate_change start — intentional: this list filters out upstream/CI bot
// identities when generating changelogs. The "opencode" / "opencode-agent[bot]"
// entries match upstream's GitHub App so its commits are excluded from our
// release notes. NOT a brand leak — these are the literal upstream identities
// we're filtering AGAINST.
const bot = ["actions-user", "opencode", "opencode-agent[bot]", "altimate-code-agent[bot]"]
// altimate_change end
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE
  },
  get team() {
    return team
  },
}
// altimate_change start — branding regression
console.log(`altimate-code script`, JSON.stringify(Script, null, 2))
// altimate_change end
