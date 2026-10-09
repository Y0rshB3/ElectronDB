import { describe, expect, it } from 'vitest'
import {
  backupStepName,
  buildCopyRestoreSteps,
  copyRestoreProblems,
  naturalStepName,
  restoreStepName,
  type CopyRestoreRecipe
} from './jobRecipes'
import { restoreTaskProblem } from './restoreTask'
import type { ConnectionConfig } from './types'

const names: Record<string, string> = { st: 'Staging', lo: 'Local', pr: 'Prod' }
const nameOf = (id: string) => names[id] ?? ''
const conn = (id: string, environment: ConnectionConfig['environment']) =>
  ({ id, name: names[id], environment, engine: 'mysql' }) as ConnectionConfig
const lookup = (id: string) =>
  ({ st: conn('st', 'staging'), lo: conn('lo', 'local'), pr: conn('pr', 'production') })[id]

function recipe(overrides: Partial<CopyRestoreRecipe> = {}): CopyRestoreRecipe {
  return {
    sourceConnectionId: 'st',
    targetConnectionId: 'lo',
    databases: [
      { name: 'ventas', target: 'ventas' },
      { name: 'auth', target: 'auth_dev' }
    ],
    safetyBackup: true,
    includeData: true,
    ...overrides
  }
}

describe('«Copiar y restaurar» recipe', () => {
  it('builds every copy first, then a restore of each copy, with natural names', () => {
    let n = 0
    const steps = buildCopyRestoreSteps(recipe(), nameOf, () => `s${++n}`)
    expect(steps).toEqual([
      {
        id: 's1',
        type: 'backupschema',
        connectionId: 'st',
        schema: 'ventas',
        referenceName: 'Copia de ventas (Staging)',
        includeData: true,
        format: 'vqb'
      },
      {
        id: 's2',
        type: 'backupschema',
        connectionId: 'st',
        schema: 'auth',
        referenceName: 'Copia de auth (Staging)',
        includeData: true,
        format: 'vqb'
      },
      {
        id: 's3',
        type: 'restoreschema',
        connectionId: 'lo',
        schema: '',
        referenceName: 'Restaurar ventas en Local',
        restoreSource: { kind: 'task', taskId: 's1' },
        safetyBackup: true,
        includeData: true
      },
      {
        id: 's4',
        type: 'restoreschema',
        connectionId: 'lo',
        schema: 'auth_dev',
        referenceName: 'Restaurar auth_dev en Local',
        restoreSource: { kind: 'task', taskId: 's2' },
        safetyBackup: true,
        includeData: true
      }
    ])
    // The job's own restore rules accept every step.
    for (const step of steps.filter((s) => s.type === 'restoreschema'))
      expect(restoreTaskProblem(step, steps, lookup, step.referenceName)).toBeNull()
  })

  it('structure only and no safety copy reach both kinds of step', () => {
    const steps = buildCopyRestoreSteps(
      recipe({ includeData: false, safetyBackup: false }),
      nameOf,
      () => Math.random().toString(36)
    )
    expect(steps.every((s) => s.includeData === false)).toBe(true)
    expect(steps.filter((s) => s.type === 'restoreschema').map((s) => s.safetyBackup)).toEqual([
      false,
      false
    ])
    for (const step of steps.filter((s) => s.type === 'restoreschema'))
      expect(restoreTaskProblem(step, steps, lookup, 'paso')).toBeNull()
  })

  it('a production target is refused by the same rules as any restore step', () => {
    const steps = buildCopyRestoreSteps(recipe({ targetConnectionId: 'pr' }), nameOf, () =>
      Math.random().toString(36)
    )
    expect(restoreTaskProblem(steps[2], steps, lookup, 'paso 3')).toContain('producción')
  })

  it('reports missing choices and repeated or invalid targets', () => {
    expect(
      copyRestoreProblems(recipe({ sourceConnectionId: '', targetConnectionId: '', databases: [] }))
    ).toEqual([
      'Elige la conexión de origen.',
      'Marca al menos una base de datos para copiar.',
      'Elige la conexión de destino.'
    ])
    expect(
      copyRestoreProblems(
        recipe({
          databases: [
            { name: 'a', target: 'x' },
            { name: 'x', target: '' },
            { name: 'b', target: 'mal/nombre' }
          ]
        })
      )
    ).toEqual([
      'Más de una base de datos se restauraría en «x».',
      '«mal/nombre» no es un nombre de base de datos válido.'
    ])
    // Three databases into one name: one message.
    expect(
      copyRestoreProblems(
        recipe({
          databases: [
            { name: 'a', target: 'x' },
            { name: 'b', target: 'x' },
            { name: 'c', target: 'x' }
          ]
        })
      )
    ).toEqual(['Más de una base de datos se restauraría en «x».'])
    expect(copyRestoreProblems(recipe())).toEqual([])
  })

  it('names steps naturally', () => {
    expect(backupStepName('ventas', 'Staging')).toBe('Copia de ventas (Staging)')
    expect(restoreStepName('ventas', 'Local')).toBe('Restaurar ventas en Local')
    expect(restoreStepName('ventas', '')).toBe('Restaurar ventas')
    const steps = buildCopyRestoreSteps(recipe(), nameOf, () => Math.random().toString(36))
    expect(naturalStepName(steps[2], steps, nameOf)).toBe('Restaurar ventas en Local')
  })
})
