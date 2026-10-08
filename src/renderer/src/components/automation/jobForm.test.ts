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
      safetyBackup: true,
      includeData: true
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
      safetyBackup: true,
      includeData: true
    })
  })

  it('persists «Solo estructura» of a restore step, and a step without includeData (older jobs) saves it as true', () => {
    const [backup, restore] = stagingToLocal()
    const structure = buildJobInput({
      ...emptyDraft(),
      name: 'Solo estructura',
      tasks: [backup, { ...restore, includeData: false }]
    })
    expect(structure.tasks[1].includeData).toBe(false)
    const legacy: JobTask = { ...restore }
    delete legacy.includeData
    const old = buildJobInput({ ...emptyDraft(), name: 'Antiguo', tasks: [backup, legacy] })
    expect(old.tasks[1].includeData).toBe(true)
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

  it('refuses a target in an environment listed in Ajustes › Seguridad and skips it as default', () => {
    const tasks = stagingToLocal()
    const draft = { ...emptyDraft(), name: 'X', tasks }
    expect(validateDraft(draft, lookup, ['production'])).toEqual([])
    expect(validateDraft(draft, lookup, ['production', 'local']).join('\n')).toMatch(
      /«Local», una conexión de entorno Local/
    )
    const blocked = (c: ConnectionConfig) => c.environment === 'local'
    expect(newRestoreTask([tasks[0]], conns, blocked).connectionId).toBe('')
  })
})

describe('backup step format', () => {
  it('stores format only for .sql backup steps (.nb3 jobs stay unchanged)', () => {
    const nb3 = { ...newTask('backupschema', 'staging', 'auth'), id: 'b1', format: 'nb3' as const }
    const sql = { ...newTask('backupschema', 'staging', 'crm'), id: 'b2', format: 'sql' as const }
    const query = { ...newTask('runquery', 'staging', 'crm'), id: 'q1', sql: 'SELECT 1' }
    const input = buildJobInput({ ...emptyDraft(), name: 'Formatos', tasks: [nb3, sql, query] })
    expect('format' in input.tasks[0]).toBe(false)
    expect(input.tasks[1].format).toBe('sql')
    expect('format' in input.tasks[2]).toBe(false)
  })

  it('refuses restoring a .sql backup step, like main does', () => {
    const [backup, restore] = stagingToLocal()
    const draft = {
      ...emptyDraft(),
      name: 'Sql',
      tasks: [{ ...backup, format: 'sql' as const }, restore]
    }
    expect(validateDraft(draft, lookup).join(' ')).toMatch(
      /una copia \.sql; las restauraciones automáticas necesitan una copia \.vqb o \.nb3/
    )
  })
})

describe('.vqb backup steps and the job password', () => {
  const vqbStep = () => ({ ...newTask('backupschema', 'staging', 'auth'), id: 'b1' })

  it('new backup steps write .vqb; format and encryption are saved', () => {
    expect(vqbStep().format).toBe('vqb')
    const input = buildJobInput({
      ...emptyDraft(),
      name: 'Cifrada',
      tasks: [{ ...vqbStep(), encrypt: true }],
      backupPassword: 'una clave larga',
      backupPasswordAgain: 'una clave larga'
    })
    expect(input.tasks[0]).toMatchObject({ format: 'vqb', encrypt: true })
    expect(input.backupPassword).toBe('una clave larga')
  })

  it('needs a confirmed password of 8+ characters unless one is stored', () => {
    const base = { ...emptyDraft(), name: 'Cifrada', tasks: [{ ...vqbStep(), encrypt: true }] }
    expect(validateDraft(base, lookup)).toContain(
      'Escribe la contraseña de cifrado de las copias (al menos 8 caracteres).'
    )
    expect(validateDraft({ ...base, hasBackupPassword: true }, lookup)).toEqual([])
    expect(
      validateDraft({ ...base, backupPassword: 'corta', backupPasswordAgain: 'corta' }, lookup)
    ).toContain('La contraseña de cifrado debe tener al menos 8 caracteres.')
    expect(
      validateDraft(
        { ...base, backupPassword: 'una clave larga', backupPasswordAgain: 'otra' },
        lookup
      )
    ).toContain('Las contraseñas de cifrado no coinciden.')
  })

  it('an unencrypted .vqb step needs no password and never sends one', () => {
    const draft = { ...emptyDraft(), name: 'Sin cifrar', tasks: [vqbStep()] }
    expect(validateDraft(draft, lookup)).toEqual([])
    const input = buildJobInput(draft)
    expect('encrypt' in input.tasks[0]).toBe(false)
    expect('backupPassword' in input).toBe(false)
  })
})

describe('job steps per engine', () => {
  const engines: ConnectionConfig[] = [
    { id: 'my', name: 'MySQL local', environment: 'local', engine: 'mysql' } as ConnectionConfig,
    { id: 'lite', name: 'Notas', environment: 'local', engine: 'sqlite' } as ConnectionConfig,
    {
      id: 'lite2',
      name: 'Notas copia',
      environment: 'local',
      engine: 'sqlite'
    } as ConnectionConfig,
    { id: 'mongo', name: 'Mongo', environment: 'staging', engine: 'mongodb' } as ConnectionConfig
  ]
  const find = (id: string) => engines.find((c) => c.id === id)

  it('a new restore step of a SQLite copy targets a local SQLite connection', () => {
    const backup = { ...newTask('backupschema', 'lite', 'main'), id: 'b1' }
    expect(newRestoreTask([backup], engines).connectionId).toBe('lite')
  })

  it('accepts .vqb backups of SQLite and MongoDB, refuses query steps there', () => {
    const draft = {
      ...emptyDraft(),
      name: 'Motores',
      tasks: [
        { ...newTask('backupschema', 'lite', 'main'), id: 'b1' },
        { ...newTask('backupschema', 'mongo', 'logs'), id: 'b2', encrypt: true },
        { ...newTask('runquery', 'mongo', 'logs'), id: 'q1', sql: 'db.x.find()' }
      ],
      backupPassword: 'una clave larga',
      backupPasswordAgain: 'una clave larga'
    }
    expect(validateDraft(draft, find)).toEqual([
      'El paso 3 es una consulta sobre «Mongo» (MongoDB): los pasos de consulta solo están disponibles en conexiones MySQL y MariaDB.'
    ])
  })

  it('refuses a restore into another engine', () => {
    const backup = { ...newTask('backupschema', 'lite', 'main'), id: 'b1' }
    const restore = { ...newRestoreTask([backup], engines), connectionId: 'my', schema: 'x' }
    const errors = validateDraft({ ...emptyDraft(), name: 'X', tasks: [backup, restore] }, find)
    expect(errors.join(' ')).toMatch(/una copia solo se restaura en una conexión del mismo motor/)
  })
})
