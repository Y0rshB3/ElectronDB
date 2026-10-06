import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, JobTask } from '@shared/types'
import {
  buildJobInput,
  defaultReferenceName,
  emptyDraft,
  newRestoreTask,
  newTask,
  validateDraft
} from './jobForm'

const conns: ConnectionConfig[] = [
  { id: 'prod', name: 'Producción', environment: 'production' } as ConnectionConfig,
  { id: 'staging', name: 'Staging', environment: 'staging' } as ConnectionConfig,
  { id: 'local', name: 'Local', environment: 'local' } as ConnectionConfig
]
const lookup = (id: string) => conns.find((c) => c.id === id)

function stagingToLocal(): JobTask[] {
  const backup = { ...newTask('backupschema', 'staging', 'auth'), id: 'b1' }
  return [backup, newRestoreTask([backup], conns)]
}

describe('restore steps in the job form', () => {
  it('a new restore step uses the last backup step and the first local connection', () => {
    const [backup, restore] = stagingToLocal()
    expect(restore).toMatchObject({
      type: 'restoreschema',
      connectionId: 'local',
      schema: '',
      restoreSource: { kind: 'task', taskId: backup.id },
      safetyBackup: true
    })
    expect(defaultReferenceName(restore, [backup, restore])).toBe('Restaurar auth')
  })

  it('builds the job input with source, safety backup and the default reference name', () => {
    const draft = { ...emptyDraft(), name: 'Staging -> Local', tasks: stagingToLocal() }
    expect(validateDraft(draft, lookup)).toEqual([])
    const input = buildJobInput(draft)
    expect(input.tasks[1]).toEqual({
      id: draft.tasks[1].id,
      type: 'restoreschema',
      connectionId: 'local',
      schema: '',
      referenceName: 'Restaurar auth',
      restoreSource: { kind: 'task', taskId: 'b1' },
      safetyBackup: true
    })
  })

  it('refuses a production target and a restore onto the source database', () => {
    const tasks = stagingToLocal()
    const prod = {
      ...emptyDraft(),
      name: 'X',
      tasks: [tasks[0], { ...tasks[1], connectionId: 'prod' }]
    }
    expect(validateDraft(prod, lookup).join('\n')).toMatch(/producción/)
    const self = {
      ...emptyDraft(),
      name: 'X',
      tasks: [tasks[0], { ...tasks[1], connectionId: 'staging' }]
    }
    expect(validateDraft(self, lookup).join('\n')).toMatch(/sobre sí misma/)
  })
})
