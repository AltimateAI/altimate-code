export type PlanLimitDetail = {
  limit_key?: string
  plan?: string
  limit?: number | null
  current?: number | null
  required_plan?: string
  upgrade_url?: string
  message?: string
}

/** Only an https URL is shown: the value comes off the wire and ends up in a terminal. */
export function safeUpgradeUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined
  try {
    const u = new URL(url)
    return u.protocol === "https:" ? u.toString() : undefined
  } catch {
    return undefined
  }
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The user-facing text for a plan-limit refusal. */
export function formatPlanLimit(detail: PlanLimitDetail): string {
  const message = typeof detail.message === "string" ? strip(detail.message) : ""
  const required = typeof detail.required_plan === "string" ? strip(detail.required_plan) : ""
  const url = safeUpgradeUrl(detail.upgrade_url)
  const base = message || "Your current plan does not include this."
  const sentence = /[.!?]$/.test(base) ? base : `${base}.`
  if (!url) return sentence
  return `${sentence} Upgrade${required ? ` to ${capitalize(required)}` : ""}: ${url}`
}
