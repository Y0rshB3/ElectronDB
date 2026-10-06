/**
 * Client-side SQL script splitter that mimics the mysql CLI: statements are
 * separated by the current delimiter (default ";"), which can be changed with
 * a `DELIMITER xx` line. Quotes and comments are honoured so that delimiters
 * inside strings, identifiers or comments never split a statement.
 */
export interface SqlStatement {
  sql: string
  /** 1-based line of the first code character of the statement. */
  startLine: number
}

type State = 'code' | 'single' | 'double' | 'backtick' | 'lineComment' | 'blockComment'

const DELIMITER_RE = /^delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v'
}

export function splitStatements(script: string): SqlStatement[] {
  const result: SqlStatement[] = []
  const src = script.replace(/\r\n/g, '\n')
  let delimiter = ';'
  let state: State = 'code'
  let buf = ''
  let hasCode = false
  let startLine = 0
  let line = 1
  let atLineStart = true
  let i = 0

  const flush = (): void => {
    const sql = buf.trim()
    if (hasCode && sql) result.push({ sql, startLine })
    buf = ''
    hasCode = false
    startLine = 0
  }

  const appendCode = (text: string): void => {
    if (!hasCode) {
      hasCode = true
      startLine = line
    }
    buf += text
  }

  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    if (state === 'code') {
      if (atLineStart && !isSpace(ch)) {
        const m = DELIMITER_RE.exec(src.slice(i, i + 200))
        if (m) {
          flush()
          delimiter = m[1]
          const consumed = m[0].length
          for (let k = 0; k < consumed; k++) if (src[i + k] === '\n') line++
          i += consumed
          atLineStart = true
          continue
        }
        atLineStart = false
      }

      if (src.startsWith(delimiter, i)) {
        flush()
        i += delimiter.length
        continue
      }

      if (ch === '\n') {
        line++
        atLineStart = true
        buf += ch
        i++
        continue
      }

      if (
        ch === '#' ||
        (ch === '-' && next === '-' && (i + 2 >= src.length || isSpace(src[i + 2])))
      ) {
        state = 'lineComment'
        buf += ch
        i++
        continue
      }
      if (ch === '/' && next === '*') {
        // `/*! ... */` (versioned) and `/*+ ... */` (optimizer hints) are executed
        // by the server, so they count as statement code, not as a comment.
        const third = src[i + 2]
        if (third === '!' || third === '+') appendCode('/*')
        else buf += '/*'
        state = 'blockComment'
        i += 2
        continue
      }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'backtick'

      if (isSpace(ch)) buf += ch
      else appendCode(ch)
      i++
      continue
    }

    if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'code'
        line++
        atLineStart = true
      }
      buf += ch
      i++
      continue
    }

    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'code'
        buf += '*/'
        i += 2
        continue
      }
      if (ch === '\n') line++
      buf += ch
      i++
      continue
    }

    // inside a quoted string / identifier
    if (ch === '\n') line++
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (ch === '\\' && state !== 'backtick' && i + 1 < src.length) {
      buf += ch + next
      if (next === '\n') line++
      i += 2
      continue
    }
    if (ch === quote) state = 'code'
    buf += ch
    i++
  }

  flush()
  return result
}
