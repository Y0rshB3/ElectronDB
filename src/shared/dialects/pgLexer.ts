/**
 * PostgreSQL lexer (docs/multi-engine-design.md, section 6): the single
 * tokenizer every PostgreSQL consumer uses (splitter, both production-guard
 * functions, destructive-statement detection). Pure and linear time: every
 * character is visited a bounded number of times.
 *
 * It follows the server's own lexical rules with standard_conforming_strings
 * on (the default since 9.1):
 * - '…' strings double the quote and never use backslash escapes;
 *   E'…' strings also accept backslash escapes; U&'…', B'…', X'…' and N'…'
 *   are prefixed variants of the standard string;
 * - $tag$…$tag$ dollar quotes (any other tag inside is plain content);
 * - "…" quoted identifiers double the quote (also U&"…");
 * - `--` starts a line comment with or without a following space;
 *   block comments nest;
 * - operators are runs of + - * / < > = ~ ! @ # % ^ & | ` ? that stop before
 *   a comment start, so `#>>`, `?|`, `@>`, `->>` and `||` are one token each;
 * - `::` (cast) and `:=` are operator tokens; `$1` is a parameter;
 * - a backslash outside quotes and comments starts a psql meta-command
 *   (`\copy`, `\d`…) that runs to the end of the line.
 */

export type PgTokenKind =
  | 'word' //    unquoted identifier or keyword (value as written)
  | 'ident' //   quoted identifier (value unescaped)
  | 'string' //  any string literal, dollar-quoted bodies included (value = raw text)
  | 'number'
  | 'param' //   $1
  | 'op' //      operator run, '::' and ':='
  | 'punct' //   ( ) [ ] , ; . :
  | 'comment' // -- line or /* nested block */
  | 'meta' //    psql backslash command up to the end of the line

export interface PgToken {
  kind: PgTokenKind
  /** Unquoted identifiers keep their spelling; quoted identifiers are unescaped. */
  value: string
  /** Offset of the first character in the source. */
  start: number
  /** Offset just after the last character. */
  end: number
  /** 1-based line of the first character. */
  line: number
}

const OP_CHARS = new Set('+-*/<>=~!@#%^&|`?'.split(''))

function isWordStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80
}

function isWordPart(c: number): boolean {
  return isWordStart(c) || (c >= 48 && c <= 57) || c === 36
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y

/** End (exclusive) of a quoted run starting at `open` (the quote char), with doubling. */
function endOfQuoted(src: string, open: number, quote: string, backslash: boolean): number {
  let i = open + 1
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (backslash && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
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

function unquoteIdent(raw: string): string {
  const body = raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw.slice(1)
  return body.replace(/""/g, '"')
}

/** Tokenizes `src`. Whitespace is skipped; comments are kept as tokens. */
export function tokenizePg(src: string): PgToken[] {
  const tokens: PgToken[] = []
  const n = src.length
  let i = 0
  let line = 1
  /** Last position whose newlines are already counted in `line`. */
  let counted = 0
  const lineAt = (pos: number): number => {
    for (; counted < pos; counted++) if (src.charCodeAt(counted) === 10) line++
    return line
  }
  const push = (kind: PgTokenKind, start: number, end: number, value: string): void => {
    tokens.push({ kind, value, start, end, line: lineAt(start) })
  }

  while (i < n) {
    const c = src.charCodeAt(i)
    const ch = src[i]
    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++
      continue
    }
    // line comment (no space needed after --)
    if (ch === '-' && src[i + 1] === '-') {
      const eol = src.indexOf('\n', i)
      const end = eol < 0 ? n : eol
      push('comment', i, end, src.slice(i, end))
      i = end
      continue
    }
    // nested block comment
    if (ch === '/' && src[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++
          j += 2
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      push('comment', i, j, src.slice(i, j))
      i = j
      continue
    }
    // prefixed strings and identifiers: E'..', U&'..', U&"..", B'..', X'..', N'..'
    if ((ch === 'e' || ch === 'E') && src[i + 1] === "'") {
      const end = endOfQuoted(src, i + 1, "'", true)
      push('string', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (
      (ch === 'u' || ch === 'U') &&
      src[i + 1] === '&' &&
      (src[i + 2] === "'" || src[i + 2] === '"')
    ) {
      const quote = src[i + 2]
      const end = endOfQuoted(src, i + 2, quote, false)
      if (quote === "'") push('string', i, end, src.slice(i, end))
      else push('ident', i, end, unquoteIdent(src.slice(i + 2, end)))
      i = end
      continue
    }
    if ('bBxXnN'.includes(ch) && src[i + 1] === "'") {
      const end = endOfQuoted(src, i + 1, "'", false)
      push('string', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === "'") {
      const end = endOfQuoted(src, i, "'", false)
      push('string', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === '"') {
      const end = endOfQuoted(src, i, '"', false)
      push('ident', i, end, unquoteIdent(src.slice(i, end)))
      i = end
      continue
    }
    if (ch === '$') {
      if (isDigit(src.charCodeAt(i + 1))) {
        let j = i + 1
        while (j < n && isDigit(src.charCodeAt(j))) j++
        push('param', i, j, src.slice(i, j))
        i = j
        continue
      }
      DOLLAR_TAG.lastIndex = i
      const m = DOLLAR_TAG.exec(src)
      if (m) {
        const tag = m[0]
        const close = src.indexOf(tag, i + tag.length)
        const end = close < 0 ? n : close + tag.length
        push('string', i, end, src.slice(i, end))
        i = end
        continue
      }
      push('punct', i, i + 1, '$')
      i++
      continue
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
      while (j < n && (isDigit(src.charCodeAt(j)) || src[j] === '.' || src[j] === '_')) j++
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
        j += 2
        while (j < n && isDigit(src.charCodeAt(j))) j++
      }
      push('number', i, j, src.slice(i, j))
      i = j
      continue
    }
    if (ch === ':') {
      if (src[i + 1] === ':' || src[i + 1] === '=') {
        push('op', i, i + 2, src.slice(i, i + 2))
        i += 2
      } else {
        push('punct', i, i + 1, ':')
        i++
      }
      continue
    }
    if (ch === '\\') {
      const eol = src.indexOf('\n', i)
      const end = eol < 0 ? n : eol
      push('meta', i, end, src.slice(i, end).trimEnd())
      i = end
      continue
    }
    if (OP_CHARS.has(ch)) {
      let j = i
      while (
        j < n &&
        OP_CHARS.has(src[j]) &&
        !(src[j] === '-' && src[j + 1] === '-') &&
        !(src[j] === '/' && src[j + 1] === '*')
      )
        j++
      push('op', i, j, src.slice(i, j))
      i = j
      continue
    }
    push('punct', i, i + 1, ch)
    i++
  }
  return tokens
}

/** Tokens without comments. */
export function codeTokens(tokens: PgToken[]): PgToken[] {
  return tokens.filter((t) => t.kind !== 'comment')
}
