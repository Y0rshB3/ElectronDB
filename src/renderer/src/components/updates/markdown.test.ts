import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseMarkdown', () => {
  it('parses headings, lists, code, quotes and rules', () => {
    const blocks = parseMarkdown(
      [
        '## Novedades',
        '',
        '- Filtro **visual**',
        '- Panel `Texto`',
        '  continúa aquí',
        '',
        '1. Uno',
        '2. Dos',
        '',
        '```sh',
        'git pull',
        '```',
        '> Nota importante',
        '---',
        'Párrafo en',
        'dos líneas.'
      ].join('\n')
    )
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'list',
      'list',
      'code',
      'quote',
      'rule',
      'paragraph'
    ])
    expect(blocks[0]).toMatchObject({ level: 2, children: [{ type: 'text', text: 'Novedades' }] })
    const bullets = blocks[1] as Extract<(typeof blocks)[number], { type: 'list' }>
    expect(bullets.ordered).toBe(false)
    expect(bullets.items[1]).toEqual({
      content: [
        { type: 'text', text: 'Panel ' },
        { type: 'code', text: 'Texto' },
        { type: 'text', text: ' continúa aquí' }
      ],
      children: []
    })
    expect((blocks[2] as { ordered: boolean }).ordered).toBe(true)
    expect(blocks[3]).toEqual({ type: 'code', text: 'git pull' })
    expect(blocks[6]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', text: 'Párrafo en dos líneas.' }]
    })
  })

  it('keeps HTML as plain text', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>')
    expect(blocks).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
      { type: 'paragraph', children: [{ type: 'text', text: '<script>alert(1)</script>' }] }
    ])
  })

  it('keeps one level of nested items', () => {
    const [list] = parseMarkdown('- **Uno:**\n  - a\n  - b\n    sigue\n- Dos')
    expect(list).toEqual({
      type: 'list',
      ordered: false,
      items: [
        {
          content: [{ type: 'strong', children: [{ type: 'text', text: 'Uno:' }] }],
          children: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b sigue' }]]
        },
        { content: [{ type: 'text', text: 'Dos' }], children: [] }
      ]
    })
  })

  it('parses tables', () => {
    const blocks = parseMarkdown(
      '| Sistema | Archivo |\n|---|:---:|\n| macOS | `x.dmg` |\n| Linux | y |\n\nfin'
    )
    expect(blocks[0]).toEqual({
      type: 'table',
      header: [[{ type: 'text', text: 'Sistema' }], [{ type: 'text', text: 'Archivo' }]],
      rows: [
        [[{ type: 'text', text: 'macOS' }], [{ type: 'code', text: 'x.dmg' }]],
        [[{ type: 'text', text: 'Linux' }], [{ type: 'text', text: 'y' }]]
      ]
    })
    expect(blocks[1].type).toBe('paragraph')
    // A lone pipe line without a separator stays a paragraph.
    expect(parseMarkdown('| a |')[0].type).toBe('paragraph')
  })

  it('handles an unclosed fence and empty input', () => {
    expect(parseMarkdown('```\nabc')).toEqual([{ type: 'code', text: 'abc' }])
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })
})

describe('parseInline', () => {
  it('keeps link text only', () => {
    expect(parseInline('ver [notas](https://evil.example/x) y ![img](a.png)')).toEqual([
      { type: 'text', text: 'ver notas y img' }
    ])
  })

  it('parses bold and italic and leaves snake_case alone', () => {
    expect(parseInline('**muy** *bien* en snake_case_name')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'muy' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'bien' }] },
      { type: 'text', text: ' en snake_case_name' }
    ])
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }])
    expect(parseInline('\\*literal\\*')).toEqual([{ type: 'text', text: '*literal*' }])
  })
})
