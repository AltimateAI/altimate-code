// Subprocess helper for prompt-profiles.test.ts: prints "<sha256> <byteLength>"
// of the assembled default builder prompt. Run in fresh processes with varied
// cwd/HOME to prove assembly is deterministic and environment-independent.
import { PromptProfiles } from "../../src/altimate/prompts/profiles"
import { sha256 } from "./prompt-identity"

const prompt = PromptProfiles.PROMPT_BUILDER
process.stdout.write(`${sha256(prompt)} ${Buffer.byteLength(prompt, "utf8")}\n`)
