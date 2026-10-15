if (process.argv[2] === "--altimate-artifact-smoke") {
  const { runArtifactSmoke } = await import("./artifact-smoke")
  await runArtifactSmoke()
  process.exit(0)
}

await import("../../cli/src/index.ts")
