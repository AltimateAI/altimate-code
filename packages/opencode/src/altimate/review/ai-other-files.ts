// altimate_change - new file: other changed project files for the AI lane
//
// With the `otherFiles` switch (`ALTIMATE_REVIEW_AI_OTHER_FILES`), changed files of kind
// `other` or `analysis` inside the dbt project root also go to the AI lane, under their own
// coverage quota (`ALTIMATE_REVIEW_AI_QUOTA_OTHER`), after the existing kinds. No rule lane
// reads them. Off, the lane's input is unchanged. `.py` files are not among them: Python
// files reach the lane only through the `pythonFiles` switch (ai-python-files.ts), under
// the Python quota, so turning that switch off stops every Python file.

/** Kinds the switch adds. */
export const AI_OTHER_KINDS: ReadonlySet<string> = new Set(["other", "analysis"])
/** Extensions the switch accepts. */
export const AI_OTHER_EXTENSIONS = [".sql", ".yml", ".yaml"]
/** Default coverage quota for the added files. */
export const AI_OTHER_FILES_QUOTA = 8

/** A changed file the switch adds: other/analysis kind, not deleted, allowed extension. */
export function isAiOtherFile(f: { path: string; status: string; kind?: string }): boolean {
  return (
    AI_OTHER_KINDS.has(f.kind ?? "") &&
    f.status !== "deleted" &&
    AI_OTHER_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext))
  )
}
