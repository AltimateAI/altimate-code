// altimate_change start — extracted from the CHANNEL IIFE in ./index.ts so the
// dist-tag decision can be tested without importing that module, which checks
// the bun version, shells out to git and fetches the npm registry at import.
//
// This decides which npm dist-tag a publish lands on. Getting it wrong in the
// `latest` direction moves every existing user onto whatever was published, and
// recovery needs npm credentials most of the team does not hold — so it is
// worth having as a pure, tested function rather than an inline expression.
// (#1233)

export type ChannelEnv = {
  OPENCODE_CHANNEL?: string | undefined
  OPENCODE_BUMP?: string | undefined
  OPENCODE_VERSION?: string | undefined
}

/** Resolve the npm dist-tag, or null when the caller should fall back to the
 * current git branch name (the local/preview path). */
export function resolveChannel(env: ChannelEnv): string | null {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_BUMP) return "latest"
  if (env.OPENCODE_VERSION) {
    const version = env.OPENCODE_VERSION.replace(/^v/, "")
    // `0.0.0-` preview builds keep falling through to the branch-name channel.
    if (version.startsWith("0.0.0-")) return null
    // A semver prerelease belongs on `beta`, never `latest`. Before this, a
    // `v0.10.0-beta.1` tag reaching this branch returned "latest" and would
    // have auto-upgraded the entire stable user base onto a beta.
    return version.includes("-") ? "beta" : "latest"
  }
  return null
}
