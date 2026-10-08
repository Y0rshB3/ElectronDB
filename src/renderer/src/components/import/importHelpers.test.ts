import { describe, expect, it } from 'vitest'
import type { ImportConnectionItem } from '@shared/importers'
import type { ProgressEvent } from '@shared/types'
import {
  LOG_LIMIT,
  appendLog,
  connectionRowStatus,
  defaultSelection,
  describeCounts,
  duplicateSchemas,
  logEntryOf,
  schemaFromFileName,
  schemaNameProblem,
  selectableKeys,
  type ImportLogEntry
} from './importHelpers'

const item = (key: string, extra: Partial<ImportConnectionItem> = {}): ImportConnectionItem => ({
  key,
  name: key,
  engine: 'mysql',
  engineLabel: 'MySQL',
  host: 'h',
  port: 3306,
  username: 'u',
  database: null,
  ssh: false,
  ssl: false,
  color: null,
  environment: 'other',
  hasPassword: false,
  existingConnectionId: null,
  unsupportedReason: null,
  warnings: [],
  ...extra
})

const event = (phase: string, extra: Partial<ProgressEvent> = {}): ProgressEvent => ({
  operationId: 'op',
  kind: 'import',
  phase,
  current: 0,
  total: 10,
  message: `msg ${phase}`,
  done: false,
  ...extra
})

describe('importHelpers', () => {
  it('classifies preview rows and preselects only new importable ones', () => {
    const preview = {
      source: 'dbeaver' as const,
      path: '/x',
      notes: [],
      containsPasswords: false,
      items: [
        item('a'),
        item('b', { existingConnectionId: 'c1' }),
        item('c', { engine: null, unsupportedReason: 'Motor no soportado' })
      ]
    }
    expect(preview.items.map(connectionRowStatus)).toEqual(['new', 'existing', 'unsupported'])
    expect(defaultSelection(preview)).toEqual(['a'])
    expect(selectableKeys(preview)).toEqual(['a', 'b'])
    expect(selectableKeys(null)).toEqual([])
  })

  it('turns progress events into log lines; periodic events only move counters', () => {
    expect(logEntryOf(event('statement'), 1)).toBeNull()
    expect(logEntryOf(event('done', { done: true }), 1)).toBeNull()
    expect(logEntryOf(event('object'), 1)).toMatchObject({ tone: 'ok', text: 'msg object' })
    expect(
      logEntryOf(
        event('objectError', {
          message: 'Error en la línea 9',
          detail: { error: 'boom', objectName: 'INSERT' }
        }),
        2
      )
    ).toEqual({ id: 2, tone: 'error', text: 'Error en la línea 9: boom', detail: 'INSERT' })
    expect(logEntryOf(event('warning'), 3)?.tone).toBe('warning')
    expect(logEntryOf(event('file'), 4)?.tone).toBe('section')
    expect(logEntryOf(event('safety'), 5)?.sticky).toBe('safety')
  })

  it('updates sticky lines in place and never drops errors past the limit', () => {
    let log: ImportLogEntry[] = []
    log = appendLog(log, { id: 1, tone: 'info', text: 'Copia previa · 1', sticky: 'safety' })
    log = appendLog(log, { id: 2, tone: 'info', text: 'Copia previa · 2', sticky: 'safety' })
    expect(log.map((e) => e.text)).toEqual(['Copia previa · 2'])
    log = [{ id: 0, tone: 'error', text: 'first error' }]
    for (let i = 1; i <= LOG_LIMIT + 5; i++)
      log = appendLog(log, { id: i, tone: 'ok', text: `${i}` })
    expect(log).toHaveLength(LOG_LIMIT)
    expect(log[0].text).toBe('first error')
    expect(log[log.length - 1].text).toBe(`${LOG_LIMIT + 5}`)
  })

  it('describes object counts in Spanish, skipping zeros', () => {
    expect(
      describeCounts({
        databases: 0,
        tables: 3,
        views: 1,
        routines: 0,
        triggers: 2,
        events: 0,
        inserts: 9
      })
    ).toBe('3 tablas, 1 vista, 2 triggers')
    expect(describeCounts(null)).toBe('')
  })

  it('proposes a database from the file name and validates names', () => {
    expect(schemaFromFileName('ventas.sql')).toBe('ventas')
    expect(schemaFromFileName('crm.SQL.GZ')).toBe('crm')
    expect(schemaNameProblem('')).toContain('Indica')
    expect(schemaNameProblem('mysql')).toContain('sistema')
    expect(schemaNameProblem('a.b')).toContain('«.»')
    expect(schemaNameProblem('x'.repeat(65))).toContain('64')
    expect(schemaNameProblem('tienda_2026')).toBeNull()
    expect(duplicateSchemas(['A', 'a', 'b', ''])).toEqual(new Set(['a']))
  })
})
