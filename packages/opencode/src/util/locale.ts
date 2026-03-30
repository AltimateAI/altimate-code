export namespace Locale {
  export function titlecase(str: string) {
    return str.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  export function time(input: number): string {
    const date = new Date(input)
    return date.toLocaleTimeString(undefined, { timeStyle: "short" })
  }

  export function datetime(input: number): string {
    const date = new Date(input)
    const localTime = time(input)
    const localDate = date.toLocaleDateString()
    return `${localTime} · ${localDate}`
  }

  export function todayTimeOrDateTime(input: number): string {
    const date = new Date(input)
    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

    if (isToday) {
      return time(input)
    } else {
      return datetime(input)
    }
  }

  export function number(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + "M"
    } else if (num >= 1000) {
      return (num / 1000).toFixed(1) + "K"
    }
    return num.toString()
  }

  export function duration(input: number) {
    if (input < 1000) {
      return `${input}ms`
    }
    if (input < 60000) {
      return `${(input / 1000).toFixed(1)}s`
    }
    if (input < 3600000) {
      const minutes = Math.floor(input / 60000)
      const seconds = Math.floor((input % 60000) / 1000)
      return `${minutes}m ${seconds}s`
    }
    if (input < 86400000) {
      const hours = Math.floor(input / 3600000)
      const minutes = Math.floor((input % 3600000) / 60000)
      return `${hours}h ${minutes}m`
    }
    // altimate_change start — upstream_fix: days/hours calculation were swapped (hours used total, not remainder)
    const days = Math.floor(input / 86400000)
    const hours = Math.floor((input % 86400000) / 3600000)
    // altimate_change end
    return `${days}d ${hours}h`
  }

  export function truncate(str: string, len: number): string {
    if (str.length <= len) return str
    return str.slice(0, len - 1) + "…"
  }

  export function truncateMiddle(str: string, maxLength: number = 35): string {
    if (str.length <= maxLength) return str

    const ellipsis = "…"
    const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
    const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

    return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
  }

  export function pluralize(count: number, singular: string, plural: string): string {
    const template = count === 1 ? singular : plural
    return template.replace("{}", count.toString())
  }

  /**
   * Format a USD cost value with appropriate precision.
   *
   * The standard Intl.NumberFormat currency formatter rounds to 2 decimal
   * places, which causes any cost below $0.005 to display as "$0.00".
   * For LLM usage this is misleading — a single message with 1K input
   * tokens on Claude Sonnet costs ~$0.003, which would round to "$0.00"
   * even though the user is being charged.
   *
   * This function uses tiered precision:
   *   $0         → "$0.00"
   *   < $0.01    → "$0.0012" (4 decimal places so sub-cent costs are visible)
   *   < $0.10    → "$0.0123" (4 decimal places for precision)
   *   >= $0.10   → "$0.12"   (standard 2 decimal places)
   */
  export function cost(amount: number): string {
    if (amount === 0) return "$0.00"
    if (amount > 0 && amount < 0.10) {
      // Use 4 decimal places so sub-cent costs are visible.
      // Strip trailing zeros but keep at least 2 decimal places.
      const raw = amount.toFixed(4)
      const trimmed = raw.replace(/0+$/, "")
      // Ensure at least 2 decimal places after the dot
      const dot = trimmed.indexOf(".")
      const decimals = dot === -1 ? 0 : trimmed.length - dot - 1
      const padded = decimals < 2 ? trimmed + "0".repeat(2 - decimals) : trimmed
      return "$" + padded
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount)
  }
}
