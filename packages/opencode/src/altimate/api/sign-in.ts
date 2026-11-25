/** The browser sign-in from a plain shell: the Altimate LLM Gateway method of the `altimate-backend`
 * provider saves the credentials every workspace command reads. `--method` skips the method picker,
 * so the command also works where stdin is not a terminal (an agent's shell, Claude Code's `!`).
 * Kept apart from the CLI commands so error messages outside the CLI can name it too. */
export const SIGN_IN_COMMAND = 'altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"'
