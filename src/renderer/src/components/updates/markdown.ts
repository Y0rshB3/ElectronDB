/**
 * Tiny markdown subset for release notes: headings, paragraphs, bullet and
 * numbered lists, fenced code, quotes and rules; inline code, bold, italic and
 * links. It produces a tree of plain strings that ReleaseNotes renders with
 * text nodes only, so HTML in the notes is shown as text, never injected.
 * Links keep only their text (opening them would need the URL allowlist).
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }

/** A list item and its nested items (one level). */
export interface ListItem {
  content: Inline[]
  children: Inline[][]
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  /** `lang`: info string of the fence (```sql -> 'sql'), when present. */
  | { type: 'code'; text: string; lang?: string }
  | { type: 'quote'; children: Inline[] }
  | { type: 'rule' }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }

const MAX_DEPTH = 4

/** Inline markup of one paragraph/line. */
export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer) out.push({ type: 'text', text: buffer })
    buffer = ''
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    // `code`
    let m = /^`([^`\n]+)`/.exec(rest)
    if (m) {
      flush()
      out.push({ type: 'code', text: m[1] })
      i += m[0].length
      continue
    }
    // [text](url) -> text (images ![alt](src) -> alt)
    m = /^!?\[([^\]\n]*)\]\([^)\n]*\)/.exec(rest)
    if (m) {
      buffer += m[1]
      i += m[0].length
      continue
    }
    if (depth < MAX_DEPTH) {
      // **bold** / __bold__
      m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
      if (m) {
        flush()
        out.push({ type: 'strong', children: parseInline(m[2], depth + 1) })
        i += m[0].length
        continue
      }
      // *italic* / _italic_ (an underscore inside a word stays literal: snake_case)
      m = /^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w])/.exec(rest)
      if (m && !(m[1] === '_' && /\w$/.test(buffer))) {
        flush()
        out.push({ type: 'em', children: parseInline(m[2], depth + 1) })
        i += m[0].length
        continue
      }
    }
    // Backslash escapes
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_[\]()#>!-]/.test(text[i + 1])) {
      buffer += text[i + 1]
      i += 2
      continue
    }
    buffer += text[i]
    i++
  }
  flush()
  return out
}

const indentOf = (line: string): number => line.length - line.trimStart().length

const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++])
      i++ // closing fence (or end of text)
      const lang = fence[2]?.toLowerCase()
      blocks.push({ type: 'code', text: code.join('\n'), ...(lang ? { lang } : {}) })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) })
      i++
      continue
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = tableCells(line).map((c) => parseInline(c))
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i]))
        rows.push(tableCells(lines[i++]).map((c) => parseInline(c)))
      blocks.push({ type: 'table', header, rows })
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]))
        quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', children: parseInline(quote.join(' ').trim()) })
      continue
    }
    const listMatch = BULLET.exec(line) ?? ORDERED.exec(line)
    if (listMatch) {
      const ordered = !BULLET.test(line)
      const pattern = ordered ? ORDERED : BULLET
      const base = indentOf(line)
      const items: { text: string; children: string[] }[] = []
      while (i < lines.length && lines[i].trim()) {
        const current = lines[i]
        const last = items[items.length - 1]
        const marker = BULLET.exec(current) ?? ORDERED.exec(current)
        if (marker && last && indentOf(current) > base) {
          // Nested item (deeper levels are flattened into one sub-list).
          last.children.push(marker[1])
        } else if (marker && pattern.test(current)) {
          items.push({ text: marker[1], children: [] })
        } else if (last && /^\s+\S/.test(current)) {
          // Continuation line of the current item or sub-item.
          if (last.children.length) last.children[last.children.length - 1] += ` ${current.trim()}`
          else last.text += ` ${current.trim()}`
        } else break
        i++
      }
      blocks.push({
        type: 'list',
        ordered,
        items: items.map((it) => ({
          content: parseInline(it.text.trim()),
          children: it.children.map((c) => parseInline(c.trim()))
        }))
      })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !ORDERED.test(lines[i]) &&
      !/^\s*>/.test(lines[i])
    )
      para.push(lines[i++].trim())
    blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) })
  }
  return blocks
}
