import type { PIICategory, PIIFinding } from "../types"

interface PatternDef {
  category: PIICategory
  regex: RegExp
  validate?: (match: string) => boolean
}

const PATTERNS: PatternDef[] = [
  {
    category: "email",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  {
    category: "api_key",
    regex: /(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|glpat-[a-zA-Z0-9_-]{20,}|xox[bsrp]-[a-zA-Z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[a-zA-Z0-9._~+\/=-]{20,})/g,
  },
  {
    category: "ip_address",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    validate: (match) => {
      // exclude semver-like patterns (e.g., 1.2.3.4 is valid IP but rare as version)
      if (/^\d+\.\d+\.\d+\.\d+$/.test(match)) {
        const parts = match.split(".").map(Number)
        return parts[0] !== 0 && parts[0] !== 127 || parts.some((p) => p > 0)
      }
      return true
    },
  },
  {
    category: "file_path",
    regex: /(?:\/Users\/[^\s"']+|\/home\/[^\s"']+|C:\\Users\\[^\s"']+|~\/[^\s"']+)/g,
  },
  {
    category: "phone",
    regex: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    validate: (match) => {
      const digits = match.replace(/\D/g, "")
      return digits.length >= 10 && digits.length <= 15
    },
  },
  {
    category: "ssn",
    regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    validate: (match) => {
      const digits = match.replace(/\D/g, "")
      return digits.length === 9 && !digits.startsWith("000") && !digits.startsWith("9")
    },
  },
  {
    category: "credit_card",
    regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
    validate: (match) => {
      const digits = match.replace(/\D/g, "")
      return digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)
    },
  },
]

function luhnCheck(num: string): boolean {
  let sum = 0
  let alt = false
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10)
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

export function detectPII(text: string | null | undefined, field?: string, spanId?: string): PIIFinding[] {
  if (!text) return []
  const findings: PIIFinding[] = []
  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      const match = m[0]
      if (pattern.validate && !pattern.validate(match)) continue
      findings.push({
        category: pattern.category,
        match,
        start: m.index,
        end: m.index + match.length,
        field: field ?? "text",
        spanId,
      })
    }
  }
  return findings
}

export function detectPIIInTrace(trace: import("../types").TraceFile): PIIFinding[] {
  const findings: PIIFinding[] = []

  if (trace.metadata.userId) {
    findings.push(...detectPII(trace.metadata.userId, "metadata.userId"))
  }
  if (trace.metadata.prompt) {
    findings.push(...detectPII(trace.metadata.prompt, "metadata.prompt"))
  }

  for (const span of trace.spans) {
    if (span.input) {
      findings.push(...detectPII(span.input, "span.input", span.spanId))
    }
    if (span.output) {
      findings.push(...detectPII(span.output, "span.output", span.spanId))
    }
  }

  return findings
}

export function addCustomPatterns(patterns: Array<{ name: string; regex: string }>) {
  for (const p of patterns) {
    PATTERNS.push({
      category: "api_key",
      regex: new RegExp(p.regex, "g"),
    })
  }
}
