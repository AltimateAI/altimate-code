// Subprocess helper for prompt-profiles.test.ts: prints "<sha256> <byteLength>"
// of the assembled default builder prompt. Run in fresh processes with varied
// cwd/HOME to prove assembly is deterministic and environment-independent.
import { PROMPT_BUILDER } from "../../src/altimate/prompts/profiles"

const hash = new Bun.CryptoHasher("sha256").update(PROMPT_BUILDER).digest("hex")
process.stdout.write(`${hash} ${Buffer.byteLength(PROMPT_BUILDER, "utf8")}\n`)
