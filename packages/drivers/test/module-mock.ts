import { afterAll, mock } from "bun:test"

/** Bun's mock.restore() restores spies, but leaves mock.module() exports installed. */
export async function restoreModuleMocksAfterTests(...specifiers: string[]): Promise<void> {
  const originals = await Promise.all(specifiers.map(async (specifier) => {
    // Copy now: Bun updates live module namespaces when a mock is installed.
    return [specifier, { ...await import(specifier) }] as const
  }))
  afterAll(() => {
    for (const [specifier, exports] of originals) mock.module(specifier, () => exports)
  })
}
