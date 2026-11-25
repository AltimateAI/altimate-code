/** Parse a release tag's major version, rejecting branch names and malformed tags. */
export function versionMajor(version: string): number {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error(`Invalid upstream version '${version}': expected a release tag like v1.17.9`)
  }
  return Number(match[1])
}

/** Negative for an older major, zero for the same major, positive for a newer major. */
export function compareVersionMajor(version: string, baseline: string): number {
  return versionMajor(version) - versionMajor(baseline)
}

export function assertSameMajor(version: string, baseline: string): void {
  if (compareVersionMajor(version, baseline) === 0) return
  throw new Error(
    `Cannot merge ${version}: its major differs from upstream baseline ${baseline}. ` +
    "A major upgrade (for example, v2) is a re-port, not a merge; see 'Major versions' in script/upstream/README.md.",
  )
}
