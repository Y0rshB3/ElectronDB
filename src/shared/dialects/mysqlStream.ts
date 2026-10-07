/**
 * Streaming version of the MySQL script splitter (`splitStatements` in
 * ./mysql.ts): same rules (DELIMITER lines, quotes with backslash escapes,
 * `-- `/`#`/block comments, `/*!` and `/*+` count as code, 1-based line of
 * the first code character, CRLF read as LF), fed chunk by chunk so a dump of
 * any size is split without holding the whole file. Only the current
 * statement and a small lookahead are kept in memory.
 *
 * `splitStatements` stays the reference (golden/mysql.json pins it); the
 * tests check that both give identical output for any chunking.
 */
import type { SqlStatement } from './types'

type State = 'code' | 'single' | 'double' | 'backtick' | 'lineComment' | 'blockComment'

const DELIMITER_RE = /^delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i
/** splitStatements inspects at most this many characters for a DELIMITER line. */
const DELIMITER_LOOKAHEAD = 200

const SPECIAL_SINGLE = /['\\\n]/g
const SPECIAL_DOUBLE = /["\\\n]/g
const SPECIAL_BACKTICK = /[`\n]/g

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v'
}

export interface StatementStreamOptions {
  /**
   * Trims each statement (default String#trim, like splitStatements). A binary
   * string (one character per byte) needs an ASCII-only trim: String#trim would
   * also remove U+00A0, which there is the last byte of a UTF-8 character.
   */
  trim?: (sql: string) => string
}

/** Trim of ASCII whitespace only (for binary strings). */
export const trimAscii = (sql: string): string =>
  sql.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '')

export class MysqlStatementStream {
  private readonly trim: (sql: string) => string

  constructor(options: StatementStreamOptions = {}) {
    this.trim = options.trim ?? ((sql) => sql.trim())
  }

  /** Unprocessed text (already CRLF-normalised). */
  private src = ''
  private carryCR = false
  private ended = false
  private delimiter = ';'
  private state: State = 'code'
  private parts: string[] = []
  private hasCode = false
  private startLine = 0
  private line = 1
  private atLineStart = true
  private out: SqlStatement[] = []

  /** Current delimiter (after the DELIMITER lines read so far). */
  get currentDelimiter(): string {
    return this.delimiter
  }

  /** Feeds the next piece of the script; returns the statements it completed. */
  push(chunk: string): SqlStatement[] {
    if (this.ended) throw new Error('MysqlStatementStream: push() after end()')
    this.feed(chunk, false)
    return this.drain()
  }

  /** Ends the script; returns the last statements. */
  end(): SqlStatement[] {
    if (!this.ended) {
      this.feed('', true)
      this.flush()
    }
    return this.drain()
  }

  private drain(): SqlStatement[] {
    const out = this.out
    this.out = []
    return out
  }

  private feed(chunk: string, final: boolean): void {
    let text = this.carryCR ? `\r${chunk}` : chunk
    this.carryCR = false
    if (!final && text.endsWith('\r')) {
      this.carryCR = true
      text = text.slice(0, -1)
    }
    if (text.includes('\r\n')) text = text.replace(/\r\n/g, '\n')
    this.src = this.src ? this.src + text : text
    this.ended = final
    this.run()
  }

  private markCode(): void {
    if (!this.hasCode) {
      this.hasCode = true
      this.startLine = this.line
    }
  }

  private flush(): void {
    const sql = this.trim(this.parts.length === 1 ? this.parts[0] : this.parts.join(''))
    if (this.hasCode && sql) this.out.push({ sql, startLine: this.startLine })
    this.parts = []
    this.hasCode = false
    this.startLine = 0
  }

  private run(): void {
    const src = this.src
    const n = src.length
    const ended = this.ended
    let i = 0
    let seg = 0
    // True when `count` characters from i are available (or the script ended).
    const avail = (count: number): boolean => i + count <= n || ended

    while (i < n) {
      const ch = src[i]
      const state = this.state

      if (state === 'code') {
        if (this.atLineStart && !isSpace(ch)) {
          if (ch === 'd' || ch === 'D') {
            if (!avail(DELIMITER_LOOKAHEAD)) break
            const m = DELIMITER_RE.exec(src.slice(i, i + DELIMITER_LOOKAHEAD))
            if (m) {
              if (i > seg) this.parts.push(src.slice(seg, i))
              this.flush()
              this.delimiter = m[1]
              const consumed = m[0].length
              for (let k = 0; k < consumed; k++) if (src[i + k] === '\n') this.line++
              i += consumed
              seg = i
              this.atLineStart = true
              continue
            }
          }
          this.atLineStart = false
        }

        const delimiter = this.delimiter
        if (!avail(delimiter.length)) break
        if (src.startsWith(delimiter, i)) {
          if (i > seg) this.parts.push(src.slice(seg, i))
          this.flush()
          i += delimiter.length
          seg = i
          continue
        }

        if (ch === '\n') {
          this.line++
          this.atLineStart = true
          i++
          continue
        }
        if (ch === '#') {
          this.state = 'lineComment'
          i++
          continue
        }
        if (ch === '-') {
          if (!avail(3)) break
          if (src[i + 1] === '-' && (i + 2 >= n || isSpace(src[i + 2]))) {
            this.state = 'lineComment'
            i++
            continue
          }
        }
        if (ch === '/') {
          if (!avail(3)) break
          if (src[i + 1] === '*') {
            const third = src[i + 2]
            if (third === '!' || third === '+') this.markCode()
            this.state = 'blockComment'
            i += 2
            continue
          }
        }
        if (ch === "'") this.state = 'single'
        else if (ch === '"') this.state = 'double'
        else if (ch === '`') this.state = 'backtick'
        if (!isSpace(ch)) this.markCode()
        i++
        continue
      }

      if (state === 'lineComment') {
        const end = src.indexOf('\n', i)
        if (end < 0) {
          i = n
          break
        }
        this.state = 'code'
        this.line++
        this.atLineStart = true
        i = end + 1
        continue
      }

      if (state === 'blockComment') {
        if (ch === '*') {
          if (!avail(2)) break
          if (src[i + 1] === '/') {
            this.state = 'code'
            i += 2
            continue
          }
          i++
          continue
        }
        if (ch === '\n') this.line++
        i++
        continue
      }

      // inside a quoted string / identifier: jump to the next special character
      const re =
        state === 'single' ? SPECIAL_SINGLE : state === 'double' ? SPECIAL_DOUBLE : SPECIAL_BACKTICK
      re.lastIndex = i
      const m = re.exec(src)
      if (!m) {
        i = n
        break
      }
      i = m.index
      const c = src[i]
      if (c === '\n') {
        this.line++
        i++
        continue
      }
      if (c === '\\') {
        if (i + 1 < n) {
          if (src[i + 1] === '\n') this.line++
          i += 2
          continue
        }
        if (!ended) break
        i++
        continue
      }
      // the closing quote
      this.state = 'code'
      i++
    }

    if (i > seg) this.parts.push(src.slice(seg, i))
    this.src = i < n ? src.slice(i) : ''
  }
}

/** Splits a script given as an iterable of chunks (convenience for tests and small inputs). */
export function* splitStatementChunks(chunks: Iterable<string>): Generator<SqlStatement> {
  const stream = new MysqlStatementStream()
  for (const chunk of chunks) yield* stream.push(chunk)
  yield* stream.end()
}
