// Single source of truth for the builder-prompt byte-identity pin
// (workload-adaptive harness PR 1). Imported by prompt-profiles.test.ts and
// the subprocess hash helper so the pin can never drift between call sites.
//
// EXPECTED_SHA256 / EXPECTED_BYTES describe the pre-split monolithic
// `src/altimate/prompts/builder.txt` as of the commit that removed it
// (7bbf8a6d23f5aa880be3e8436d3e74764e5928a4). A deliberate prompt edit must
// update this pin (last: the keep-the-user's-changes principle in core.txt) — and that PR then needs its own quality evidence, because
// byte identity no longer covers it.
export const EXPECTED_SHA256 = "73cab02ab2b647be40e4458d609e47a578ccd1fc980785b77b500dd04c8c7c2a"
export const EXPECTED_BYTES = 15011

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}
