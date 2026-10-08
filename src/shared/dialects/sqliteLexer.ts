/**
 * SQLite lexer (docs/multi-engine-design.md, section 6): the single tokenizer
 * every SQLite consumer uses (splitter, both production-guard functions,
 * destructive-statement detection, result editability). Pure and linear time.
 *
 * It follows SQLite's own tokenizer (tokenize.c):
 * - '…' strings double the quote; backslashes are plain characters;
 *   X'…' is a blob literal (a string token here);
 * - identifiers are quoted with "…" (doubling), […] (no escape, ends at the
 *   first `]`) or `…` (doubling). A "…" token is always an identifier here:
 *   SQLite only falls back to a string when the name cannot be resolved;
 * - `--` starts a line comment (no space needed); block comments do NOT nest
 *   and an unterminated one runs to the end of the input;
 * - parameters: ?, ?NNN, :name, @name and $name (a $name may contain `::`
 *   segments and a trailing `(…)` suffix, as in Tcl variables).
 */

export type SqliteTokenKind =
  | 'word' //    unquoted identifier or keyword (value as written)
  | 'ident' //   quoted identifier (value unescaped)
  | 'string' //  '…' or X'…' (value = raw text)
  | 'number'
  | 'param' //   ?, ?1, :a, @a, $a
  | 'op' //      operator run (||, <=, ->>, …)
  | 'punct' //   ( ) , ; .
  | 'comment' // -- line or /* block */

export interface SqliteToken {
  kind: SqliteTokenKind
  /** Unquoted identifiers keep their spelling; quoted identifiers are unescaped. */
  value: string
  /** Offset of the first character in the source. */
  start: number
  /** Offset just after the last character. */
  end: number
  /** 1-based line of the first character. */
  line: number
}

const OP_CHARS = new Set('+-*/<>=~!&|%^'.split(''))
/** Two-character operators of SQLite's tokenizer. */
const MULTI_OPS = new Set(['||', '<=', '>=', '==', '!=', '<>', '<<', '>>', '->'])

function isWordStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80
}

function isWordPart(c: number): boolean {
  return isWordStart(c) || (c >= 48 && c <= 57) || c === 36
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/** End (exclusive) of a quoted run starting at `open` (the quote char), with doubling. */
function endOfDoubled(src: string, open: number, quote: string): number {
  let i = open + 1
  const n = src.length
  while (i < n) {
    if (src[i] === quote) {
      if (src[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return n
}

function unquote(raw: string, close: string, doubled: boolean): string {
  const body = raw.length >= 2 && raw.endsWith(close) ? raw.slice(1, -1) : raw.slice(1)
  return doubled ? body.split(close + close).join(close) : body
}

/** Tokenizes `src`. Whitespace is skipped; comments are kept as tokens. */
export function tokenizeSqlite(src: string): SqliteToken[] {
  const tokens: SqliteToken[] = []
  const n = src.length
  let i = 0
  let line = 1
  let counted = 0
  const lineAt = (pos: number): number => {
    for (; counted < pos; counted++) if (src.charCodeAt(counted) === 10) line++
    return line
  }
  const push = (kind: SqliteTokenKind, start: number, end: number, value: string): void => {
    tokens.push({ kind, value, start, end, line: lineAt(start) })
  }

  while (i < n) {
    const c = src.charCodeAt(i)
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++
      continue
    }
    if (ch === '-' && src[i + 1] === '-') {
      const eol = src.indexOf('\n', i)
      const end = eol < 0 ? n : eol
      push('comment', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      push('comment', i, end, src.slice(i, end))
      i = end
      continue
    }
    if ((ch === 'x' || ch === 'X') && src[i + 1] === "'") {
      const end = endOfDoubled(src, i + 1, "'")
      push('string', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === "'") {
      const end = endOfDoubled(src, i, "'")
      push('string', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === '"' || ch === '`') {
      const end = endOfDoubled(src, i, ch)
      push('ident', i, end, unquote(src.slice(i, end), ch, true))
      i = end
      continue
    }
    if (ch === '[') {
      const close = src.indexOf(']', i + 1)
      const end = close < 0 ? n : close + 1
      push('ident', i, end, unquote(src.slice(i, end), ']', false))
      i = end
      continue
    }
    if (ch === '?') {
      let j = i + 1
      while (j < n && isDigit(src.charCodeAt(j))) j++
      push('param', i, j, src.slice(i, j))
      i = j
      continue
    }
    if ((ch === ':' || ch === '@' || ch === '$') && i + 1 < n) {
      let j = i + 1
      for (;;) {
        while (j < n && isWordPart(src.charCodeAt(j))) j++
        // $a::b (Tcl namespaces)
        if (ch === '$' && src[j] === ':' && src[j + 1] === ':') {
          j += 2
          continue
        }
        break
      }
      if (ch === '$' && j > i + 1 && src[j] === '(') {
        const close = src.indexOf(')', j)
        if (close >= 0) j = close + 1
      }
      if (j > i + 1) {
        push('param', i, j, src.slice(i, j))
        i = j
        continue
      }
    }
    if (isWordStart(c)) {
      let j = i + 1
      while (j < n && isWordPart(src.charCodeAt(j))) j++
      push('word', i, j, src.slice(i, j))
      i = j
      continue
    }
    if (isDigit(c) || (ch === '.' && isDigit(src.charCodeAt(i + 1)))) {
      let j = i
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++
      } else {
        while (j < n && (isDigit(src.charCodeAt(j)) || src[j] === '.' || src[j] === '_')) j++
        if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
          j += 2
          while (j < n && isDigit(src.charCodeAt(j))) j++
        }
      }
      push('number', i, j, src.slice(i, j))
      i = j
      continue
    }
    if (OP_CHARS.has(ch)) {
      // Only SQLite's own multi-character operators (tokenize.c); anything else is one
      // character, so `x=-1` is `=` then `-` (a run like `=-` would hide an assignment).
      const three = src.slice(i, i + 3)
      const two = src.slice(i, i + 2)
      const len = three === '->>' ? 3 : MULTI_OPS.has(two) ? 2 : 1
      push('op', i, i + len, src.slice(i, i + len))
      i += len
      continue
    }
    push('punct', i, i + 1, ch)
    i++
  }
  return tokens
}

/** Tokens without comments. */
export function sqliteCodeTokens(tokens: SqliteToken[]): SqliteToken[] {
  return tokens.filter((t) => t.kind !== 'comment')
}
