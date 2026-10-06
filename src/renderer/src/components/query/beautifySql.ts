import { format } from 'sql-formatter'
import { formatSql } from './formatSql'

export interface BeautifyResult {
  sql: string
  /** False when the text could not be parsed and only keywords were upper-cased. */
  structured: boolean
}

const DELIMITER_RE = /^\s*DELIMITER\s+(\S+)\s*$/i

/**
 * Navicat-style "Embellecer SQL": one clause per line, clause contents
 * indented with a tab, upper-case keywords, a blank line between statements.
 * Blocks written under a custom DELIMITER (procedures, triggers...) keep their
 * layout and only get keywords upper-cased, because the formatter cannot parse
 * client-side DELIMITER syntax. Unparseable input falls back the same way.
 */
export function beautifySql(sql: string): BeautifyResult {
  if (!sql.trim()) return { sql, structured: true }
  const lines = sql.split('\n')
  if (!lines.some((l) => DELIMITER_RE.test(l))) return beautifyPlain(sql)

  // Split into segments: plain SQL (formatted) and DELIMITER blocks (kept).
  const out: string[] = []
  let structured = true
  let plain: string[] = []
  let delimiter = ';'
  let block: string[] = []
  const flushPlain = (): void => {
    if (plain.join('\n').trim()) {
      const r = beautifyPlain(plain.join('\n'))
      structured &&= r.structured
      out.push(r.sql)
    }
    plain = []
  }
  for (const line of lines) {
    const m = DELIMITER_RE.exec(line)
    if (m) {
      if (delimiter === ';') flushPlain()
      else if (block.length) out.push(formatBlock(block, delimiter))
      block = []
      out.push(`DELIMITER ${m[1]}`)
      delimiter = m[1]
      continue
    }
    if (delimiter === ';') plain.push(line)
    else block.push(line)
  }
  if (delimiter === ';') flushPlain()
  else if (block.length) out.push(formatBlock(block, delimiter))
  return { sql: out.join('\n\n'), structured }
}

/** Upper-cases keywords in a DELIMITER block without letting `END$$` hide the keyword. */
function formatBlock(lines: string[], delimiter: string): string {
  const marker = '\u0000'
  const text = lines.join('\n').split(delimiter).join(marker)
  return formatSql(text).split(marker).join(delimiter).trim()
}

/** Fixes sql-formatter quirks so the output matches Navicat's. */
function polish(sql: string): string {
  // Operators such as LIKE/IS/NOT/IN are not always upper-cased by sql-formatter's MySQL dialect.
  const upper = formatSql(sql)
  // `CALL p ()` -> `CALL p()`
  return upper.replace(/\b(CALL\s+(?:`[^`]+`|[\w$]+)(?:\.(?:`[^`]+`|[\w$]+))?)\s+\(/g, '$1(')
}

function beautifyPlain(sql: string): BeautifyResult {
  try {
    const formatted = format(sql, {
      language: 'mysql',
      keywordCase: 'upper',
      dataTypeCase: 'upper',
      functionCase: 'upper',
      identifierCase: 'preserve',
      useTabs: true,
      linesBetweenQueries: 1,
      expressionWidth: 60
    })
    return { sql: polish(formatted), structured: true }
  } catch {
    return { sql: formatSql(sql), structured: false }
  }
}
