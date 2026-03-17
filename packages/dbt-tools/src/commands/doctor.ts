import type { Config } from "../config"
import { all } from "../check"

export async function doctor(cfg: Config) {
  const result = await all(cfg)

  const summary = Object.entries(result.checks).map(([name, status]) => {
    if (status.ok) return { check: name, status: "ok" }
    return { check: name, status: "fail", error: status.error, fix: status.fix }
  })

  return { passed: result.passed, checks: summary }
}
