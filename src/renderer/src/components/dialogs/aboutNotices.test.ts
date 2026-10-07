import { describe, expect, it } from 'vitest'
import { filterNotices, splitNotices } from './aboutNotices'

const RULE = '='.repeat(78)
const sample = [
  'Vortaq 0.2.0 — Licencias de terceros\n\nComponentes: 2',
  `${RULE}\nvue 3.5.42\nLicencia: MIT\n\n--- LICENSE ---\n\nCopyright (c) Evan You`,
  `${RULE}\nvuetify 3.13.4\nLicencia: MIT`,
  `${RULE}\n`
].join('\n\n')

describe('splitNotices', () => {
  it('separates the header and one section per component', () => {
    const { header, sections } = splitNotices(sample)
    expect(header).toContain('Componentes: 2')
    expect(sections.map((s) => s.title)).toEqual(['vue 3.5.42', 'vuetify 3.13.4'])
    expect(sections[0].body).toContain('Copyright (c) Evan You')
  })

  it('handles an empty text', () => {
    expect(splitNotices('')).toEqual({ header: '', sections: [] })
  })
})

describe('filterNotices', () => {
  it('matches the component name case-insensitively', () => {
    const { sections } = splitNotices(sample)
    expect(filterNotices(sections, 'VUETIFY').map((s) => s.title)).toEqual(['vuetify 3.13.4'])
    expect(filterNotices(sections, '  ')).toHaveLength(2)
  })
})
