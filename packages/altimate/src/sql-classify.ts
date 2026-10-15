// Ported from v1's fallback; altimate-core's AST parser is absent in this spike.
// Require approval for WITH/EXPLAIN and comment markers: they can conceal writes
// (including EXPLAIN ANALYZE and comment-looking text inside string literals).
export function classifyAndCheck(sql: string) {
  const statements = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)

  return {
    queryType:
      /--|\/\*/.test(sql) || statements.some((statement) => !/^\s*(SELECT|SHOW|DESCRIBE|DESC)\b/i.test(statement))
        ? "write"
        : "read",
    blocked: statements.some((statement) => /^\s*(DROP\s+(DATABASE|SCHEMA)\b|TRUNCATE(\s+TABLE)?\b)/i.test(statement)),
  }
}
