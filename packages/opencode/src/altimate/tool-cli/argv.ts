/**
 * yargs parses a lone `-` as a positional, so `tool run --args -` (read the arguments from stdin)
 * is folded into `--args=-` before parsing.
 */
export function foldStdinArgs(argv: string[]): string[] {
  return argv.flatMap((arg, index) =>
    arg === "-" && argv[index - 1] === "--args" ? [] : arg === "--args" && argv[index + 1] === "-" ? ["--args=-"] : [arg],
  )
}
