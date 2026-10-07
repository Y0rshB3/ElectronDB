/** One component of THIRD_PARTY_LICENSES.txt: «name version» and its licence block. */
export interface NoticeSection {
  title: string
  body: string
}

/**
 * Splits THIRD_PARTY_LICENSES.txt (scripts/third-party-licenses.mjs) into
 * its header and one section per component; sections are separated by a
 * line of exactly 78 '=' characters (licence texts may underline their own
 * headings with shorter or longer ones) and start with «name version».
 */
export function splitNotices(text: string): { header: string; sections: NoticeSection[] } {
  const parts = text.split(/^={78}$/m).map((p) => p.trim())
  const header = parts.shift() ?? ''
  const sections = parts
    .filter((p) => p.length > 0)
    .map((p) => {
      const at = p.indexOf('\n')
      return at < 0
        ? { title: p, body: '' }
        : { title: p.slice(0, at).trim(), body: p.slice(at + 1).trim() }
    })
  return { header, sections }
}

/** Sections whose title (package name and version) contains the query. */
export function filterNotices(sections: NoticeSection[], query: string): NoticeSection[] {
  const q = query.trim().toLowerCase()
  return q ? sections.filter((s) => s.title.toLowerCase().includes(q)) : sections
}
