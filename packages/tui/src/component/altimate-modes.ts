// Auto Mode tier metadata for the altimate-backend provider. Kept in an altimate-owned file so the
// upstream-derived picker and prompt only need thin hooks.
export const ALTIMATE_MODE_PROVIDER = "altimate-backend"

export const ALTIMATE_MODES: Record<string, { label: string; description: string; order: number }> = {
  "altimate-auto": { label: "Auto", description: "Balanced default", order: 0 },
  "altimate-fast": { label: "Fast", description: "Fastest, lowest cost", order: 1 },
  "altimate-max": { label: "Max", description: "Most capable", order: 2 },
}

export function altimateMode(providerID: string, modelID: string) {
  return providerID === ALTIMATE_MODE_PROVIDER ? ALTIMATE_MODES[modelID] : undefined
}

type PickerRow = { value: unknown; title: string; description?: string; category?: string }

function rowModelID(row: PickerRow) {
  const v = row.value as { providerID?: string; modelID?: string } | string
  if (typeof v === "string") return undefined
  return altimateMode(v.providerID ?? "", v.modelID ?? "") ? v.modelID : undefined
}

/** Split tier rows out of the READY rows into an ordered "AUTO MODE" section. */
export function splitModeRows<T extends PickerRow>(rows: T[]): { modes: T[]; rest: T[] } {
  const modes = rows.filter((r) => rowModelID(r))
  const rest = rows.filter((r) => !rowModelID(r))
  modes.sort((a, b) => ALTIMATE_MODES[rowModelID(a)!].order - ALTIMATE_MODES[rowModelID(b)!].order)
  return {
    modes: modes.map((r) => {
      const meta = ALTIMATE_MODES[rowModelID(r)!]
      return { ...r, title: meta.label, description: meta.description, category: "AUTO MODE" }
    }),
    rest,
  }
}
