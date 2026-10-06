import { describe, expect, it } from 'vitest'
import {
  environmentPhrase,
  normalizeTypedConfirmEnvironments,
  requiresTypedConfirm
} from './typedConfirm'
import { guardedRiskSignature, guardedWriteTargets } from './productionGuard'
import type { ConnectionConfig, JobTask } from './types'

describe('normalizeTypedConfirmEnvironments', () => {
  it('always includes production, in canonical order, without duplicates or unknown values', () => {
    expect(normalizeTypedConfirmEnvironments(undefined)).toEqual(['production'])
    expect(normalizeTypedConfirmEnvironments(true)).toEqual(['production'])
    expect(normalizeTypedConfirmEnvironments([])).toEqual(['production'])
    expect(normalizeTypedConfirmEnvironments(['other', 'staging', 'staging', 'nope', 1])).toEqual([
      'production',
      'staging',
      'other'
    ])
    expect(normalizeTypedConfirmEnvironments(['local', 'production'])).toEqual([
      'production',
      'local'
    ])
  })
})

describe('requiresTypedConfirm', () => {
  it('production always; others only when listed', () => {
    expect(requiresTypedConfirm('production', [])).toBe(true)
    expect(requiresTypedConfirm('production', null)).toBe(true)
    expect(requiresTypedConfirm('staging', ['production'])).toBe(false)
    expect(requiresTypedConfirm('staging', ['production', 'staging'])).toBe(true)
    expect(requiresTypedConfirm(undefined, ['staging'])).toBe(false)
  })

  it('names the environment for messages', () => {
    expect(environmentPhrase('production')).toBe('producción')
    expect(environmentPhrase('staging')).toBe('entorno Staging')
    expect(environmentPhrase('other')).toBe('entorno Otro')
  })
})

describe('guardedWriteTargets', () => {
  const conns: Record<string, ConnectionConfig> = {
    p: { id: 'p', name: 'P', environment: 'production' } as ConnectionConfig,
    s: { id: 's', name: 'S', environment: 'staging' } as ConnectionConfig,
    l: { id: 'l', name: 'L', environment: 'local' } as ConnectionConfig
  }
  const sql = (connectionId: string): JobTask => ({
    id: `t-${connectionId}`,
    type: 'runquery',
    connectionId,
    schema: 'a',
    referenceName: 'x',
    sql: 'DELETE FROM t'
  })
  const lookup = (id: string) => conns[id]

  it('lists SQL targets in production and the listed environments', () => {
    const tasks = [sql('p'), sql('s'), sql('l')]
    expect(guardedWriteTargets(tasks, lookup, ['production']).map((c) => c.id)).toEqual(['p'])
    expect(guardedWriteTargets(tasks, lookup, []).map((c) => c.id)).toEqual(['p'])
    expect(guardedWriteTargets(tasks, lookup, ['staging']).map((c) => c.id)).toEqual(['p', 's'])
  })

  it('risk signature changes when an environment is added to the list', () => {
    const schedule = { enabled: true, cron: '0 3 * * *' }
    expect(guardedRiskSignature([sql('s')], schedule, lookup, ['production'])).toBe('')
    expect(guardedRiskSignature([sql('s')], schedule, lookup, ['staging'])).not.toBe('')
  })
})
