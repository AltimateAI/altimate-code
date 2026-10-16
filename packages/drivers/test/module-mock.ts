import { afterAll, mock } from "bun:test"

/** Bun's mock.restore() restores spies, but leaves mock.module() exports installed. */
export async function restoreModuleMocksAfterTests(...specifiers: string[]): Promise<void> {
  const originals = await Promise.all(specifiers.map(async (specifier) => {
    try {
      import.meta.resolve(specifier)
    } catch {
      // Optional SDKs can be mocked even when they are not installed.
      return
    }
    // Copy now: Bun updates live module namespaces when a mock is installed.
    return [specifier, { ...await import(specifier) }] as const
  }))
  afterAll(() => {
    for (const original of originals) {
      if (!original) continue
      const [specifier, exports] = original
      mock.module(specifier, () => exports)
    }
  })
}
