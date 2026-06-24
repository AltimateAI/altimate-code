import { resetDatabase } from "../fixture/db"
import { Database as LegacyDatabase } from "../../src/storage/db"

let prepared: Promise<void> | undefined

export function prepareReleaseValidationDatabase() {
  prepared ??= (async () => {
    LegacyDatabase.close()
    await resetDatabase()
    LegacyDatabase.Client()
    LegacyDatabase.close()
  })()
  return prepared
}
