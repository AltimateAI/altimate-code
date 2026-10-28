export const PTY_CONNECT_TICKET_QUERY = "ticket"
export const PTY_CONNECT_TOKEN_HEADER = "x-opencode-ticket"
export const PTY_CONNECT_TOKEN_HEADER_VALUE = "1"

// altimate_change start — upstream_fix: authorize PTY ticket bypass from the matched route (anomalyco/opencode#58258)
export const PTY_CONNECT_PATH = "/pty/:ptyID/connect"
// altimate_change end
