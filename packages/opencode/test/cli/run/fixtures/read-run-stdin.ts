// altimate_change - new file
// Reads this process's real stdin with `readRunStdin`, as `run` does, and prints the result.
import { readRunStdin, stdinWaitMs } from "../../../../src/altimate/cli/run-stdin"

const result = await readRunStdin(undefined, stdinWaitMs(), process.argv[2] !== "unbounded")
process.stdout.write(JSON.stringify(result))
