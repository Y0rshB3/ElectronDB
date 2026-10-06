import { parseMarkdown, type Block, type Inline } from './markdown'

/**
 * The few lines the update popup shows instead of the whole release notes:
 * - the bullets of a «## Destacado» section when the release has one;
 * - otherwise the first-level bullets of «## Novedades», keeping only their
 *   bold lead («**Buscar actualizaciones**: aviso…» -> «Buscar actualizaciones»);
 * - otherwise the first-level bullets of the first list.
 * At most MAX_HIGHLIGHTS lines of HIGHLIGHT_MAX_CHARS characters.
 */

export const MAX_HIGHLIGHTS = 5
export const HIGHLIGHT_MAX_CHARS = 90

function plain(inlines: Inline[]): string {
  return inlines
    .map((i) => (i.type === 'text' || i.type === 'code' ? i.text : plain(i.children)))
    .join('')
}

function headingText(block: Block): string | null {
  return block.type === 'heading' ? plain(block.children).trim() : null
}

/** List items of the section whose level-1/2 heading matches `title`. */
function sectionItems(blocks: Block[], title: RegExp): Inline[][] | null {
  const start = blocks.findIndex(
    (b) => b.type === 'heading' && b.level <= 2 && title.test(headingText(b) ?? '')
  )
  if (start < 0) return null
  const items: Inline[][] = []
  for (const block of blocks.slice(start + 1)) {
    if (block.type === 'heading' && block.level <= 2) break
    if (block.type === 'list') items.push(...block.items.map((i) => i.content))
  }
  return items
}

/** Bold text that opens the bullet, without a trailing colon or dash. */
function boldLead(content: Inline[]): string | null {
  const first = content.find((i) => !(i.type === 'text' && !i.text.trim()))
  if (!first || first.type !== 'strong') return null
  const text = plain(first.children)
    .replace(/[\s:–—-]+$/, '')
    .trim()
  return text || null
}

export function truncateHighlight(text: string, max = HIGHLIGHT_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`
}

export function releaseHighlights(notes: string | undefined | null): string[] {
  if (!notes?.trim()) return []
  const blocks = parseMarkdown(notes)
  let lines: string[]
  const featured = sectionItems(blocks, /^destacad[oa]s?$/i)
  if (featured?.length) {
    lines = featured.map(plain)
  } else {
    const news =
      sectionItems(blocks, /^novedades$/i) ??
      (
        blocks.find((b) => b.type === 'list') as Extract<Block, { type: 'list' }> | undefined
      )?.items.map((i) => i.content) ??
      []
    lines = news.map((content) => boldLead(content) ?? plain(content))
  }
  return lines
    .map((l) => truncateHighlight(l))
    .filter(Boolean)
    .slice(0, MAX_HIGHLIGHTS)
}
