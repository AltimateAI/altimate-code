// Subprocess fixture used by stdin-e2e.test.ts.
// Imports the real helper, invokes it against real fd 0, and prints the
// result as JSON so the test can assert on it.
import { readStdinIfAvailable } from "../../src/util/stdin"

const start = Date.now()
const result = await readStdinIfAvailable()
const elapsed = Date.now() - start
process.stdout.write(JSON.stringify({ result, elapsed }))
