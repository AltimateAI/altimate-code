import { disposeAllInstances } from "../fixture/fixture"

export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
}
