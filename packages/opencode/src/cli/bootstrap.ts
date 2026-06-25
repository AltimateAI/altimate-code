import { InstanceRuntime } from "../project/instance-runtime"
// altimate_change start — upstream_fix: provide the loaded instance on the CANONICAL `Instance` ALS
// (project/instance.ts, backed by util/context) that every reader actually uses — `Instance.current`/
// `.directory`, the run-service makeRuntime `attach` bridge, and therefore `Config.get()` / `Skill.all()`
// called from plain-async CLI code. Previously bootstrap provided on project/instance-context.ts's
// SEPARATE `LocalContext` ALS (util/local-context) — a different AsyncLocalStorage that nothing reads
// (every other importer of instance-context takes only the `InstanceContext` TYPE). The instance was
// thus set in a dead namespace, so every plain-async facade call under bootstrap threw "InstanceRef
// not provided" — silently disabling session tracing and breaking `skill list`/`create`/`test`.
import { Instance } from "../project/instance"
// altimate_change end

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  // altimate_change start — upstream_fix: load the instance, then restore the loaded ctx on the
  // canonical `Instance` ALS (was: `Instance.provide` over instance-context's unread `LocalContext`
  // ALS, which left every plain-async facade reader without an instance). See import note above.
  const ctx = await InstanceRuntime.load({ directory })
  try {
    return await Instance.restore(ctx, cb)
  } finally {
    await InstanceRuntime.disposeInstance(ctx)
  }
  // altimate_change end
}
