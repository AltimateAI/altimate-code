// altimate_change start — upstream_fix helper extracted to a dependency-free module (no imports of
// ../filesystem) so it can be unit-tested without triggering the filesystem<->search import cycle.
import path from "path"
import os from "os"

/**
 * fff (the native file picker) aborts the process with SIGTRAP when basePath is an unbounded root
 * like the home directory or the filesystem root: there is no .gitignore to bound the walk, so it
 * tries to index the entire tree. FileSystemSearch.defaultLayer uses this to fall back to the
 * bounded ripgrep layer for those roots. See ./search.ts.
 */
export function isUnboundedScanRoot(dir: string): boolean {
  const resolved = path.resolve(dir)
  if (resolved === path.parse(resolved).root) return true
  const home = os.homedir()
  return home.length > 0 && path.resolve(home) === resolved
}
// altimate_change end
