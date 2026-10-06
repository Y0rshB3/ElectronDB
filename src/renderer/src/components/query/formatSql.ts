const KEYWORDS = new Set(
  (
    'add all alter and as asc auto_increment begin between by call case change column commit constraint create cross ' +
    'database default delete desc describe distinct drop else end engine exists explain false for foreign from full ' +
    'function grant group having if ignore in index inner insert interval into is join key left like limit lock ' +
    'modify not null offset on or order outer primary procedure references regexp rename replace revoke right ' +
    'rollback schema select set show start table then to transaction trigger true truncate union unique unlock ' +
    'update use using values view when where with'
  ).split(' ')
)

/**
 * Minimal formatter: upper-cases SQL keywords outside of strings, quoted
 * identifiers and comments. Layout is preserved on purpose.
 */
export function formatSql(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length && sql[j] !== ch) j += sql[j] === '\\' && ch !== '`' ? 2 : 1
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if ((ch === '-' && next === '-') || ch === '#') {
      const end = sql.indexOf('\n', i)
      const j = end < 0 ? sql.length : end
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const j = end < 0 ? sql.length : end + 2
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++
      const word = sql.slice(i, j)
      // Skip qualified names like t.select or schema.table
      const qualified = out.endsWith('.') || sql[j] === '.'
      out += !qualified && KEYWORDS.has(word.toLowerCase()) ? word.toUpperCase() : word
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}
