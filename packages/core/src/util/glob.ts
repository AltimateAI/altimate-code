import { glob, globSync, type GlobOptions } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  // altimate_change start — upstream_fix: restore the `ignore` option.
  // Without it every `**/…` scan walks the entire tree (node_modules, .git,
  // dist, …) and callers can only filter the *results*, after the directories
  // have already been read. `glob` treats an ignore pattern ending in `/**` as
  // "prune this subtree", so passing it through turns a full-tree walk into a
  // source-tree walk. See DEFAULT_IGNORE below for the shared exclusion set.
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
    ignore?: string[]
  }

  /**
   * Dependency, VCS, and tool-cache trees that are never authored project
   * content. Use this narrower set for content discovery that must still see
   * user files under directories named `build`, `dist`, `out`, etc.
   */
  export const DEPENDENCY_IGNORE: readonly string[] = [
    "**/node_modules/**",
    "**/vendor/**",
    "**/.git/**",
    "**/.pnpm/**",
    "**/.venv/**",
    "**/.turbo/**",
  ]

  /**
   * Full generated/dependency exclusion set for discovery paths that already
   * rejected these directories before traversal pruning was restored (notably
   * MCP config discovery). Every pattern ends in `/**` so `glob` prunes the
   * subtree instead of walking it and discarding the matches afterwards.
   */
  export const DEFAULT_IGNORE: readonly string[] = [
    ...DEPENDENCY_IGNORE,
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/.next/**",
    "**/out/**",
    "**/coverage/**",
  ]

  /** Translate the wrapper contract to `glob` without dropping traversal ignores. */
  // altimate_change end
  function toGlobOptions(options: Options): GlobOptions {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
      // altimate_change start — upstream_fix: pass `ignore` through so the walk is pruned
      ignore: options.ignore,
      // altimate_change end
    }
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    return glob(pattern, toGlobOptions(options)) as Promise<string[]>
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    return globSync(pattern, toGlobOptions(options)) as string[]
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
