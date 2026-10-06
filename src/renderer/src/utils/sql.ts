export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

export function quoteString(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

export function qualified(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name)
}

/** Strip comments and string literals so keyword heuristics do not misfire. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < sql.length) {
        current += sql[++i]
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';') {
      if (current.trim()) out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export interface DestructiveCheck {
  destructive: boolean
  /** Human readable reasons such as "DELETE sin WHERE". */
  reasons: string[]
}

/** Heuristic classification of a SQL script for the production guard. */
export function analyzeDestructive(sql: string): DestructiveCheck {
  const reasons: string[] = []
  for (const stmt of splitStatements(stripLiterals(sql))) {
    const upper = stmt.toUpperCase().replace(/\s+/g, ' ').trim()
    if (/^(DROP|TRUNCATE)\b/.test(upper)) reasons.push(upper.split(' ').slice(0, 2).join(' '))
    else if (/^ALTER\b/.test(upper)) reasons.push('ALTER')
    else if (/^DELETE\b/.test(upper) && !/\bWHERE\b/.test(upper)) reasons.push('DELETE sin WHERE')
    else if (/^UPDATE\b/.test(upper) && !/\bWHERE\b/.test(upper)) reasons.push('UPDATE sin WHERE')
    else if (
      /^(DELETE|UPDATE|INSERT|REPLACE|CREATE|RENAME|GRANT|REVOKE|SET PASSWORD)\b/.test(upper)
    ) {
      reasons.push(upper.split(' ')[0])
    }
  }
  return { destructive: reasons.length > 0, reasons: [...new Set(reasons)] }
}

export function createUserSql(
  user: string,
  host: string,
  password: string,
  plugin?: string | null
): string {
  const identified = plugin
    ? `IDENTIFIED WITH ${quoteIdent(plugin)} BY ${quoteString(password)}`
    : `IDENTIFIED BY ${quoteString(password)}`
  return `CREATE USER ${quoteString(user)}@${quoteString(host)} ${identified};`
}

export function dropUserSql(user: string, host: string): string {
  return `DROP USER ${quoteString(user)}@${quoteString(host)};`
}

export function alterPasswordSql(user: string, host: string, password: string): string {
  return `ALTER USER ${quoteString(user)}@${quoteString(host)} IDENTIFIED BY ${quoteString(password)};`
}

export function lockUserSql(user: string, host: string, lock: boolean): string {
  return `ALTER USER ${quoteString(user)}@${quoteString(host)} ACCOUNT ${lock ? 'LOCK' : 'UNLOCK'};`
}

/** Rewrite `DEFINER=`x`@`y`` clauses to CURRENT_USER. */
export function replaceDefiner(sql: string): string {
  return sql.replace(
    /DEFINER\s*=\s*(`[^`]*`|'[^']*'|\w+)@(`[^`]*`|'[^']*'|\w+)/gi,
    'DEFINER=CURRENT_USER'
  )
}

export function formatCellForSql(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return quoteString(String(value))
}
