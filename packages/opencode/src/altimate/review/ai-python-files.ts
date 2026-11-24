// altimate_change - new file: changed Python files for the AI lane
//
// With the `pythonFiles` switch (`ALTIMATE_REVIEW_AI_PYTHON_FILES`), every changed,
// non-deleted `.py` file in the repository (inside or outside the dbt project root) that the
// lane does not already send goes to the AI lane, under its own coverage quota
// (`ALTIMATE_REVIEW_AI_QUOTA_PYTHON`), after the existing kinds. Files outside the project
// root reach the orchestrator only for the AI lane (`OrchestrateInput.aiOutsideFiles`); no
// rule lane reads them. Off, the lane's input is unchanged.
import { shouldReview } from "./diff-filter"

/** Kind the added files carry in the AI lane. */
export const AI_PYTHON_KIND = "python_file"
/** Default coverage quota for the added files. */
export const AI_PYTHON_FILES_QUOTA = 6

/** A changed file the switch adds: `.py`, not deleted, not a build or vendored path. */
export function isAiPythonFile(f: { path: string; status: string }): boolean {
  return f.status !== "deleted" && f.path.toLowerCase().endsWith(".py") && shouldReview(f.path)
}
