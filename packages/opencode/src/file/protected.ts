import path from "path"
import os from "os"

const home = os.homedir()

// macOS directories that trigger TCC (Transparency, Consent, and Control)
// permission prompts when accessed by a non-sandboxed process.
const DARWIN_HOME = [
  // Media
  "Music",
  "Pictures",
  "Movies",
  // User-managed folders synced via iCloud / subject to TCC
  "Downloads",
  "Desktop",
  "Documents",
  // Other system-managed
  "Public",
  "Applications",
  "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
]

const DARWIN_ROOT = ["/.DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]

const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

/**
 * Directories and file patterns that should require explicit permission before
 * write operations, even when they are located inside the project boundary.
 * These contain credentials, version control state, or configuration that
 * should not be modified without the user's awareness.
 */
const SENSITIVE_DIRS = [
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
]

const SENSITIVE_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account.json",
  "id_rsa",
  "id_ed25519",
]

export namespace Protected {
  /** Directory basenames to skip when scanning the home directory. */
  export function names(): ReadonlySet<string> {
    if (process.platform === "darwin") return new Set(DARWIN_HOME)
    if (process.platform === "win32") return new Set(WIN32_HOME)
    return new Set()
  }

  /** Absolute paths that should never be watched, stated, or scanned. */
  export function paths(): string[] {
    if (process.platform === "darwin")
      return [
        ...DARWIN_HOME.map((n) => path.join(home, n)),
        ...DARWIN_LIBRARY.map((n) => path.join(home, "Library", n)),
        ...DARWIN_ROOT,
      ]
    if (process.platform === "win32") return WIN32_HOME.map((n) => path.join(home, n))
    return []
  }

  /**
   * Check if a file path targets a sensitive directory or file that should
   * require explicit user permission before modification, even inside the project.
   * Returns the name of the matched sensitive pattern, or undefined if not sensitive.
   */
  export function isSensitiveWrite(filepath: string): string | undefined {
    // Split on both / and \ for cross-platform safety
    const segments = filepath.split(/[/\\]/)
    const filename = segments[segments.length - 1] ?? ""

    // Check if any path segment is a sensitive directory
    for (const segment of segments) {
      if (SENSITIVE_DIRS.includes(segment)) {
        return segment
      }
    }

    // Check if the filename matches a sensitive file pattern
    for (const pattern of SENSITIVE_FILES) {
      if (filename === pattern) return pattern
      // Match .env.* variants (e.g., .env.local.bak)
      if (pattern === ".env" && filename.startsWith(".env.")) return filename
    }

    return undefined
  }
}
