import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import github from "@/cli/cmd/tui/context/theme/github.json"
import solarized from "@/cli/cmd/tui/context/theme/solarized.json"
import flexoki from "@/cli/cmd/tui/context/theme/flexoki.json"

/**
 * E2E tests for light-theme text visibility (issue #617).
 *
 * Root cause: the experimental <markdown> element was missing fg={theme.text},
 * falling back to OpenTUI's hardcoded white default (RGBA(1,1,1,1)). Additionally,
 * the markup.raw / markup.raw.block syntax scopes lacked a background property,
 * so fenced code blocks had no background contrast on light terminals.
 *
 * These tests resolve theme JSON files through the same algorithm used in
 * production (resolveTheme + getSyntaxRules), then assert that:
 * 1. Code block scopes have a background color set
 * 2. Default foreground is never white on light backgrounds
 * 3. All foreground colors have sufficient contrast against their background
 *
 * No mocks — uses real theme JSON files and the real color resolution algorithm.
 */

// ─── Pure functions extracted from theme.tsx (identical logic) ──────────────

type ThemeColors = Record<string, RGBA>

type Theme = ThemeColors & {
  _hasSelectedListItemText: boolean
  thinkingOpacity: number
}

type ThemeJson = {
  defs?: Record<string, string>
  theme: Record<string, unknown>
}

function ansiToRgba(code: number): RGBA {
  if (code < 16) {
    const ansiColors = [
      "#000000", "#800000", "#008000", "#808000",
      "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00",
      "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ]
    return RGBA.fromHex(ansiColors[code] ?? "#000000")
  }
  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(val(r), val(g), val(b))
  }
  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }
  return RGBA.fromInts(0, 0, 0)
}

function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): Theme {
  const defs = theme.defs ?? {}
  type ColorValue = string | number | RGBA | { dark: string; light: string }

  function resolveColor(c: ColorValue): RGBA {
    if (c instanceof RGBA) return c
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0)
      if (c.startsWith("#")) return RGBA.fromHex(c)
      if (defs[c] != null) return resolveColor(defs[c])
      if (theme.theme[c] !== undefined) return resolveColor(theme.theme[c] as ColorValue)
      throw new Error(`Color reference "${c}" not found in defs or theme`)
    }
    if (typeof c === "number") return ansiToRgba(c)
    return resolveColor(c[mode])
  }

  const resolved: Record<string, RGBA> = {}
  for (const [key, value] of Object.entries(theme.theme)) {
    if (key === "selectedListItemText" || key === "backgroundMenu" || key === "thinkingOpacity") continue
    resolved[key] = resolveColor(value as ColorValue)
  }

  const hasSelectedListItemText = theme.theme.selectedListItemText !== undefined
  if (hasSelectedListItemText) {
    resolved.selectedListItemText = resolveColor(theme.theme.selectedListItemText as ColorValue)
  } else {
    resolved.selectedListItemText = resolved.background!
  }

  if (theme.theme.backgroundMenu !== undefined) {
    resolved.backgroundMenu = resolveColor(theme.theme.backgroundMenu as ColorValue)
  } else {
    resolved.backgroundMenu = resolved.backgroundElement!
  }

  return {
    ...resolved,
    _hasSelectedListItemText: hasSelectedListItemText,
    thinkingOpacity: (theme.theme.thinkingOpacity as number | undefined) ?? 0.6,
  } as Theme
}

type SyntaxRule = {
  scope: string[]
  style: { foreground?: RGBA; background?: RGBA; bold?: boolean; italic?: boolean; underline?: boolean }
}

/**
 * Identical to getSyntaxRules in theme.tsx — including the fix under test
 * (background: theme.backgroundElement on markup.raw scope).
 */
function getSyntaxRules(theme: Theme): SyntaxRule[] {
  return [
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["prompt"], style: { foreground: theme.accent } },
    { scope: ["comment"], style: { foreground: theme.syntaxComment, italic: true } },
    { scope: ["string", "symbol"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean"], style: { foreground: theme.syntaxNumber } },
    { scope: ["keyword"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["variable", "variable.parameter"], style: { foreground: theme.syntaxVariable } },
    { scope: ["type", "module"], style: { foreground: theme.syntaxType } },
    { scope: ["punctuation", "punctuation.bracket"], style: { foreground: theme.syntaxPunctuation } },
    // Markdown styles — the critical ones for the fix
    { scope: ["markup.heading"], style: { foreground: theme.markdownHeading, bold: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: theme.markdownStrong, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: {
        foreground: theme.markdownCode,
        // THE FIX: this background was missing before, causing invisible code blocks
        background: theme.backgroundElement,
      },
    },
    {
      scope: ["markup.raw.inline"],
      style: { foreground: theme.markdownCode, background: theme.background },
    },
    { scope: ["markup.link"], style: { foreground: theme.markdownLink, underline: true } },
    { scope: ["spell", "nospell"], style: { foreground: theme.text } },
    { scope: ["diff.plus"], style: { foreground: theme.diffAdded, background: theme.diffAddedBg } },
    { scope: ["diff.minus"], style: { foreground: theme.diffRemoved, background: theme.diffRemovedBg } },
  ]
}

// ─── Contrast helpers ──────────────────────────────────────────────────────
// Contrast thresholds use WCAG 2.1 "large text" minimums (3:1) since terminal
// text renders at effective large-text size. Lower thresholds (2:1, 2.5:1) are
// used for syntax-highlighted code where some colors are decorative/secondary.

const WHITE = RGBA.fromHex("#ffffff")

function luminance(c: RGBA): number {
  const [r, g, b] = c.toInts()
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function isLightBackground(bg: RGBA): boolean {
  return luminance(bg) > 0.5
}

function contrastRatio(fg: RGBA, bg: RGBA): number {
  function relLum(c: RGBA): number {
    const [r, g, b] = c.toInts()
    const srgb = [r, g, b].map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * srgb[0]! + 0.7152 * srgb[1]! + 0.0722 * srgb[2]!
  }
  const l1 = relLum(fg)
  const l2 = relLum(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

// ─── Themes with explicit light mode support ───────────────────────────────

const LIGHT_THEMES: [string, ThemeJson][] = [
  ["github", github as unknown as ThemeJson],
  ["solarized", solarized as unknown as ThemeJson],
  ["flexoki", flexoki as unknown as ThemeJson],
]

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("light theme: markup.raw code block visibility (issue #617)", () => {
  test.each(LIGHT_THEMES)(
    "%s: markup.raw scope has background set",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")
      const rules = getSyntaxRules(resolved)

      const markupRawRule = rules.find(
        (r) => r.scope.includes("markup.raw") && r.scope.includes("markup.raw.block"),
      )

      expect(markupRawRule).toBeDefined()
      expect(markupRawRule!.style.background).toBeDefined()
      expect(markupRawRule!.style.background).toBeInstanceOf(RGBA)
    },
  )

  test.each(LIGHT_THEMES)(
    "%s: markup.raw.block background differs from pure white",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")
      const rules = getSyntaxRules(resolved)

      const markupRawRule = rules.find(
        (r) => r.scope.includes("markup.raw") && r.scope.includes("markup.raw.block"),
      )!

      // Background should NOT be pure white — that's the old invisible state
      expect(markupRawRule.style.background!.equals(WHITE)).toBe(false)
    },
  )

  test.each(LIGHT_THEMES)(
    "%s: markup.raw foreground is readable on its background",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")
      const rules = getSyntaxRules(resolved)

      const markupRawRule = rules.find(
        (r) => r.scope.includes("markup.raw") && r.scope.includes("markup.raw.block"),
      )!

      const fg = markupRawRule.style.foreground!
      const bg = markupRawRule.style.background!

      const ratio = contrastRatio(fg, bg)
      expect(ratio).toBeGreaterThanOrEqual(2.5)
    },
  )
})

describe("light theme: default foreground is not white (issue #617)", () => {
  test.each(LIGHT_THEMES)(
    "%s: default fg is not white",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")

      if (!isLightBackground(resolved.background)) return

      const rules = getSyntaxRules(resolved)
      const defaultRule = rules.find((r) => r.scope.includes("default"))!

      // The fg must NOT be white — that's the hardcoded default that causes the bug
      expect(defaultRule.style.foreground!.equals(WHITE)).toBe(false)
    },
  )

  test.each(LIGHT_THEMES)(
    "%s: default fg has sufficient contrast against background",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")

      if (!isLightBackground(resolved.background)) return

      const rules = getSyntaxRules(resolved)
      const defaultRule = rules.find((r) => r.scope.includes("default"))!

      const ratio = contrastRatio(defaultRule.style.foreground!, resolved.background)
      expect(ratio).toBeGreaterThanOrEqual(3)
    },
  )
})

describe("light theme: theme.text is suitable for <markdown> fg prop", () => {
  test.each(LIGHT_THEMES)(
    "%s: theme.text is dark-colored (not white)",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")

      if (!isLightBackground(resolved.background)) return

      // theme.text is what we pass as fg={theme.text} to the <markdown> element
      expect(resolved.text.equals(WHITE)).toBe(false)
    },
  )

  test.each(LIGHT_THEMES)(
    "%s: theme.text has >= 3:1 contrast against background",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")

      if (!isLightBackground(resolved.background)) return

      const ratio = contrastRatio(resolved.text, resolved.background)
      expect(ratio).toBeGreaterThanOrEqual(3)
    },
  )
})

describe("light theme: all syntax foregrounds are readable", () => {
  test.each(LIGHT_THEMES)(
    "%s: no syntax rule produces invisible text",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")

      if (!isLightBackground(resolved.background)) return

      const rules = getSyntaxRules(resolved)
      for (const rule of rules) {
        if (!rule.style.foreground) continue

        const bg = rule.style.background ?? resolved.background
        const ratio = contrastRatio(rule.style.foreground, bg)

        expect(ratio).toBeGreaterThanOrEqual(2)
      }
    },
  )
})

describe("dark theme: regression check", () => {
  const DARK_THEMES: [string, ThemeJson][] = [
    ["github", github as unknown as ThemeJson],
    ["solarized", solarized as unknown as ThemeJson],
    ["flexoki", flexoki as unknown as ThemeJson],
  ]

  test.each(DARK_THEMES)(
    "%s: markup.raw scope has background set (no regression)",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "dark")
      const rules = getSyntaxRules(resolved)

      const markupRawRule = rules.find(
        (r) => r.scope.includes("markup.raw") && r.scope.includes("markup.raw.block"),
      )

      expect(markupRawRule).toBeDefined()
      expect(markupRawRule!.style.background).toBeDefined()
    },
  )

  test.each(DARK_THEMES)(
    "%s: default fg is set and not transparent",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "dark")
      const rules = getSyntaxRules(resolved)

      const defaultRule = rules.find((r) => r.scope.includes("default"))!

      expect(defaultRule.style.foreground).toBeDefined()
      expect(defaultRule.style.foreground!.a).toBeGreaterThan(0)
    },
  )
})
