import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_MAX_CHARS,
  MAX_HIGHLIGHTS,
  releaseHighlights,
  truncateHighlight
} from './highlights'

describe('releaseHighlights', () => {
  it('prefers the «Destacado» section, keeping the whole bullet text', () => {
    const notes = [
      '## Destacado',
      '',
      '- Confirmación antes de **borrar** en cualquier conexión',
      '- Popups de actualización',
      '',
      '## Novedades',
      '',
      '- **Otra cosa**: detalle'
    ].join('\n')
    expect(releaseHighlights(notes)).toEqual([
      'Confirmación antes de borrar en cualquier conexión',
      'Popups de actualización'
    ])
  })

  it('otherwise uses the first-level bullets of «Novedades» with their bold lead only', () => {
    const notes = [
      '## Novedades',
      '',
      '- **Buscar actualizaciones**: aviso al iniciar y opción en el menú.',
      '  - detalle anidado que no se muestra',
      '- **Filtros** — sin escribir SQL',
      '- `Copiar como INSERT` en el menú contextual',
      '',
      '## Correcciones',
      '',
      '- **No debe aparecer**'
    ].join('\n')
    expect(releaseHighlights(notes)).toEqual([
      'Buscar actualizaciones',
      'Filtros',
      'Copiar como INSERT en el menú contextual'
    ])
  })

  it('truncates long lines and keeps at most five', () => {
    const long = 'palabra '.repeat(30)
    const notes = [
      '## Novedades',
      '',
      ...Array.from({ length: 8 }, (_, i) => `- ${i} ${long}`)
    ].join('\n')
    const lines = releaseHighlights(notes)
    expect(lines).toHaveLength(MAX_HIGHLIGHTS)
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(HIGHLIGHT_MAX_CHARS)
      expect(l.endsWith('…')).toBe(true)
    }
    expect(truncateHighlight('corto')).toBe('corto')
  })

  it('falls back to the first list and handles empty notes', () => {
    expect(releaseHighlights('Texto\n\n- **Uno**: a\n- Dos')).toEqual(['Uno', 'Dos'])
    expect(releaseHighlights('')).toEqual([])
    expect(releaseHighlights(undefined)).toEqual([])
    expect(releaseHighlights('Solo un párrafo.')).toEqual([])
  })

  it('never keeps HTML markup as markup (plain text only)', () => {
    expect(releaseHighlights('## Novedades\n\n- <b>sin html</b>')).toEqual(['<b>sin html</b>'])
  })
})
