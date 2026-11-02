import { registerAll as registerCore } from "../../src/altimate/native/altimate-core"
import { registerAllSql } from "../../src/altimate/native/sql/register"
import { registerAll as registerConnections } from "../../src/altimate/native/connections/register"
import { registerAll as registerSchema } from "../../src/altimate/native/schema/register"
import { registerAll as registerFinops } from "../../src/altimate/native/finops/register"
import { registerAll as registerDbt } from "../../src/altimate/native/dbt/register"
import { registerAll as registerLocal } from "../../src/altimate/native/local/register"

/** Reinstalls every default Dispatcher handler, for files that depend on them after other files called Dispatcher.reset(). */
export function registerDefaultNativeHandlers(): void {
  registerCore()
  registerAllSql()
  registerConnections()
  registerSchema()
  registerFinops()
  registerDbt()
  registerLocal()
}
