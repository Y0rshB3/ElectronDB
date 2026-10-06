import { describe, expect, it } from 'vitest'
import { objectLine, stampLine } from '@shared/jobLog'
import { LOG_CHUNK_LINES, RunLogModel } from './runLogModel'

const at = new Date(2026, 9, 5, 17, 38, 14)
const L = (body: string): string => stampLine(at, body)
const table = (i: number): string =>
  L(objectLine({ type: 'Table', name: `t${i}`, count: i, status: 'ok' }))

describe('RunLogModel', () => {
  it('parses incrementally and keeps finished chunks identical', () => {
    const lines = [L('Paso 1/1 · Base de datos accounts (Local)')]
    for (let i = 1; i < 250; i++) lines.push(table(i))
    const model = new RunLogModel()
    model.sync(0, lines, 0)
    const first = model.chunks()
    expect(first.map((c) => [c.key, c.rows.length, c.headings])).toEqual([
      [0, 100, 1],
      [1, 100, 0],
      [2, 50, 0]
    ])
    expect(first[1].rows[0].n).toBe(100)

    lines.push(table(250), table(251))
    model.sync(0, lines, 0)
    const second = model.chunks()
    // Only the last chunk is rebuilt.
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]).not.toBe(first[2])
    expect(second[2].rows).toHaveLength(52)
    expect(model.size).toBe(252)
  })

  it('follows a trimmed front without shifting line numbers', () => {
    const all = Array.from({ length: 300 }, (_, i) => table(i))
    const model = new RunLogModel()
    model.sync(0, all, 0)
    const before = model.chunks()
    // The store dropped the first 30 lines.
    model.sync(30, all.slice(30), 0)
    const after = model.chunks()
    expect(after[0].rows[0].n).toBe(30)
    expect(after[0]).not.toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })

  it('separates the summary and re-parses everything when the buffer is replaced', () => {
    const lines = [
      L('Paso 1/1 · Base de datos accounts (Local)'),
      L('  Resultado: OK · 1 objeto'),
      '',
      L('Resumen'),
      L('  Pasos: 1 · Correctos: 1 · Con error: 0 · Cancelados: 0 · Omitidos: 0'),
      L('Finalizado correctamente: 1 de 1 paso OK.')
    ]
    const model = new RunLogModel()
    model.sync(0, lines, 0)
    expect(model.chunks()[0].rows.map((r) => r.kind)).toEqual(['heading', 'result'])
    expect(model.summary().map((r) => r.kind)).toEqual(['summary', 'summary', 'final'])
    expect(model.size).toBe(5)

    // New generation (file loaded over a gap): content at the same numbers may differ.
    const replaced = [L('Paso 1/1 · Base de datos crm (Local)')]
    model.sync(0, replaced, 1)
    expect(model.chunks()[0].rows.map((r) => r.text)).toEqual([
      'Paso 1/1 · Base de datos crm (Local)'
    ])
    expect(model.summary()).toEqual([])
    expect(LOG_CHUNK_LINES).toBe(100)
  })
})
