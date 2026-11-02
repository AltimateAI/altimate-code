// altimate_change start — the dbt project's adapter type, read without starting the adapter
/** Whether the working directory has a dbt project, and the adapter type its compiled manifest
 * records (`metadata.adapter_type`, undefined before the project is compiled). Side-effect free. */
export async function dbtProjectAdapterType(): Promise<{ project: boolean; type?: string }> {
  try {
    const { read: readDbtConfig } = await import("../../../../../dbt-tools/src/config")
    const dbtConfig = await readDbtConfig()
    if (!dbtConfig) return { project: false }
    const fs = await import("fs")
    const path = await import("path")
    const manifestPath = path.join(dbtConfig.projectRoot, "target", "manifest.json")
    if (!fs.existsSync(manifestPath)) return { project: true }
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    const adapter = String(raw?.metadata?.adapter_type ?? "").toLowerCase()
    return { project: true, ...(adapter && { type: adapter }) }
  } catch {
    return { project: false }
  }
}
// altimate_change end
