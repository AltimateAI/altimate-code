/**
 * Re-read the manifest when another process is rewriting it.
 *
 * Every `altimate-dbt` process runs `dbt parse` when it starts, and dbt rewrites
 * `target/manifest.json` in place. A process that reads the file while a sibling
 * is rewriting it gets nothing back: the library's `parseManifest` returns
 * `undefined` and later calls fail with "not found in manifest" or "No manifest
 * has been generated". The window is a few milliseconds, but processes started
 * together move in lockstep (previously the unconditional `dbt deps` of each
 * process spread them out), so it was hit in about 1 call in 9 when four ran at once.
 * The file is complete again moments later, so reading again is the repair.
 */

export interface ManifestSource<T> {
  parseManifest(): Promise<T | undefined>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Replace `source.parseManifest` with a version that retries while the result is missing. */
export function retryParseManifest<T>(
  source: ManifestSource<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): void {
  const attempts = opts.attempts ?? 6
  const base = opts.baseDelayMs ?? 150
  const original = source.parseManifest.bind(source)
  source.parseManifest = async () => {
    let result = await original()
    for (let i = 1; result === undefined && i < attempts; i++) {
      await sleep(base * i + Math.floor(Math.random() * base))
      result = await original()
    }
    return result
  }
}
