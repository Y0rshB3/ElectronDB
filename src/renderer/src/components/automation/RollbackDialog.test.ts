import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { JobRun, RollbackPlan } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useJobsStore } from '@renderer/stores/jobs'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import {
  calls,
  freshPinia,
  makeConnection,
  mockVortaq,
  mountWith,
  settle
} from '@renderer/components/dialogs/testing'
import RollbackDialog from './RollbackDialog.vue'
import RunHistory from './RunHistory.vue'
import { jobOutcome } from '@renderer/stores/progress'
import {
  cancelRestorePrompt,
  canRollback,
  contentText,
  rollbackConfirmation,
  selectedByDefault
} from './rollback'

const run: JobRun = {
  id: 'run-1',
  jobId: 'job-1',
  jobName: 'Backup staging',
  status: 'success',
  trigger: 'schedule',
  startedAt: '2026-10-05T03:00:00.000Z',
  finishedAt: '2026-10-05T03:01:00.000Z',
  logPath: '/tmp/run-1.log',
  tasks: [
    {
      taskId: 'b1',
      referenceName: 'Backup auth',
      status: 'success',
      startedAt: null,
      finishedAt: null,
      message: null,
      outputPath: '/b/staging/auth/20261005030000-backup-staging.nb3',
      type: 'backupschema',
      connectionId: 'staging',
      schema: 'auth'
    },
    {
      taskId: 'b2',
      referenceName: 'Backup crm',
      status: 'success',
      startedAt: null,
      finishedAt: null,
      message: null,
      outputPath: '/b/staging/crm/20261005030000-backup-staging.nb3',
      type: 'backupschema',
      connectionId: 'staging',
      schema: 'crm'
    }
  ]
}

function planFor(targetId: string | null): RollbackPlan {
  return {
    runId: 'run-1',
    jobId: 'job-1',
    jobName: 'Backup staging',
    runStartedAt: run.startedAt,
    targetConnectionId: targetId,
    targetError: null,
    items: [
      {
        taskId: 'b1',
        referenceName: 'Backup auth',
        sourceConnectionId: 'staging',
        sourceConnectionName: 'Staging',
        schema: 'auth',
        targetSchema: 'auth',
        backupPath: run.tasks[0].outputPath!,
        sizeBytes: 4096,
        targetExists: true,
        problem: null,
        objects: 3,
        rows: 1234,
        structureOnly: false,
        warning: null
      },
      {
        taskId: 'b2',
        referenceName: 'Backup crm',
        sourceConnectionId: 'staging',
        sourceConnectionName: 'Staging',
        schema: 'crm',
        targetSchema: 'crm',
        backupPath: run.tasks[1].outputPath!,
        sizeBytes: 1024,
        targetExists: false,
        problem: null,
        objects: 1,
        rows: 4,
        structureOnly: false,
        warning: null
      }
    ]
  }
}

const started: JobRun = { ...run, id: 'run-rb', status: 'running', kind: 'rollback', tasks: [] }

describe('RollbackDialog', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'jobs:rollbackPlan': (_runId: unknown, targetId: unknown) => planFor(targetId as string),
      'jobs:rollback': () => started
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountDialog() {
    const pinia = freshPinia()
    const connections = useConnectionsStore()
    // Production sorts first: it must never be preselected.
    connections.items = [
      makeConnection({ id: 'prod', name: 'Aaa Producción', environment: 'production' }),
      makeConnection({ id: 'staging', name: 'Staging', environment: 'staging' }),
      makeConnection({ id: 'local', name: 'Local', environment: 'local', backupDir: '/b/local' })
    ]
    connections.loaded = true
    wrapper = mountWith(RollbackDialog, pinia, {
      props: { run, modelValue: true }
    } as never)
    await settle()
    return wrapper
  }

  it('defaults to the first local connection, every database checked and the safety backup on', async () => {
    const w = await mountDialog()
    expect(calls(invoke, 'jobs:rollbackPlan')).toEqual([['run-1', 'local']])
    expect(w.text()).toContain('Restaurar todo en Local')
    const checks = w.findAll('[data-test="rollback-item-check"] input')
    expect(checks).toHaveLength(2)
    for (const c of checks) expect((c.element as HTMLInputElement).checked).toBe(true)
    const states = w.findAll('[data-test="rollback-item-state"]').map((s) => s.text())
    expect(states).toEqual(['Se reemplaza', 'Nueva'])
    expect(w.get('[data-test="rollback-items"]').text()).toMatch(/auth.*Staging.*auth.*Local/)
    expect((w.get('[data-test="rollback-safety"] input').element as HTMLInputElement).checked).toBe(
      true
    )
    expect(w.get('[data-test="rollback-submit"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test="rollback-production-warning"]').exists()).toBe(false)
  })

  it('asks for confirmation listing exactly the databases that will be replaced, then starts the run', async () => {
    const w = await mountDialog()
    const ui = useUiStore()
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.requireTyped).toBeUndefined()
    expect(ui.confirm.details).toContain('Se REEMPLAZARÁN en «Local»')
    expect(ui.confirm.details).toContain('• auth  ← auth de Staging')
    expect(ui.confirm.details).toMatch(/Se crearán en «Local»:\n {2}• crm/)
    expect(ui.confirm.details!.split('Se crearán')[0]).not.toContain('crm')
    expect(ui.confirm.message).toContain('copia de seguridad previa')
    expect(calls(invoke, 'jobs:rollback')).toHaveLength(0)

    ui.answer(true)
    await settle()
    const sent = calls(invoke, 'jobs:rollback')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toEqual({
      runId: 'run-1',
      targetConnectionId: 'local',
      taskIds: ['b1', 'b2'],
      safetyBackup: true,
      includeData: true
    })
    // Not production: no confirmProduction flag.
    expect(sent[0][1]).toBeUndefined()
    expect(useJobsStore().runs.map((r) => r.id)).toContain('run-rb')
    expect(w.emitted('started')?.[0]).toEqual([started])
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('sends only the checked databases and the safety choice; cancelling the confirmation does nothing', async () => {
    const w = await mountDialog()
    const ui = useUiStore()
    await w.findAll('[data-test="rollback-item-check"] input')[1].setValue(false)
    await w.get('[data-test="rollback-safety"] input').setValue(false)
    expect(w.find('[data-test="rollback-no-safety"]').exists()).toBe(true)
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm.message).toContain('SIN copia previa')
    ui.answer(false)
    await settle()
    expect(calls(invoke, 'jobs:rollback')).toHaveLength(0)
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    ui.answer(true)
    await settle()
    expect(calls(invoke, 'jobs:rollback')[0][0]).toMatchObject({
      taskIds: ['b1'],
      safetyBackup: false
    })
  })

  it('shows «Contenido» (default «Estructura y datos»); «Solo estructura» is in the confirmation and the request', async () => {
    const w = await mountDialog()
    const ui = useUiStore()
    const content = w.get('[data-test="replace-content"]')
    expect(content.text()).toContain('Contenido')
    expect(content.get('[data-test="replace-content-data"]').classes()).toContain('v-btn--active')
    await content.get('[data-test="replace-content-structure"]').trigger('click')
    await settle()
    expect(w.get('[data-test="replace-content-hint"]').text()).toBe(
      'Tablas con sus relaciones (claves foráneas, índices), vistas, rutinas, eventos y disparadores, sin filas'
    )
    expect(w.text()).toContain('con las tablas vacías (solo estructura)')
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm.message).toContain('Solo estructura: se crearán las tablas vacías')
    ui.answer(true)
    await settle()
    expect(calls(invoke, 'jobs:rollback')[0][0]).toMatchObject({
      taskIds: ['b1', 'b2'],
      includeData: false
    })
  })

  it('a production target requires typing its name and sends confirmProduction', async () => {
    const w = await mountDialog()
    const ui = useUiStore()
    const select = w.findComponent({ name: 'VSelect' })
    select.vm.$emit('update:modelValue', 'prod')
    await settle()
    expect(calls(invoke, 'jobs:rollbackPlan').at(-1)).toEqual(['run-1', 'prod'])
    expect(w.find('[data-test="rollback-production-warning"]').exists()).toBe(true)
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm).toMatchObject({
      open: true,
      production: true,
      requireTyped: 'Aaa Producción'
    })
    ui.answer(true)
    await settle()
    expect(calls(invoke, 'jobs:rollback')[0]).toEqual([
      {
        runId: 'run-1',
        targetConnectionId: 'prod',
        taskIds: ['b1', 'b2'],
        safetyBackup: true,
        includeData: true
      },
      { confirmProduction: true }
    ])
  })

  it('a staging target listed in Ajustes requires typing its name (one dialog) and sends confirmProduction', async () => {
    const w = await mountDialog()
    useSettingsStore().settings.typedConfirmEnvironments = ['production', 'staging']
    const ui = useUiStore()
    w.findComponent({ name: 'VSelect' }).vm.$emit('update:modelValue', 'staging')
    await settle()
    const warning = w.get('[data-test="rollback-production-warning"]')
    expect(warning.text()).toContain(
      '«Staging» es una conexión de entorno Staging que requiere confirmación'
    )
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm).toMatchObject({
      open: true,
      production: true,
      typedEnvironment: 'staging',
      requireTyped: 'Staging'
    })
    ui.answer(true)
    await settle()
    expect(ui.confirm.open).toBe(false)
    expect(calls(invoke, 'jobs:rollback')[0][1]).toEqual({ confirmProduction: true })
  })

  it('a staging target that is not listed asks a plain confirmation and sends no flag', async () => {
    const w = await mountDialog()
    const ui = useUiStore()
    w.findComponent({ name: 'VSelect' }).vm.$emit('update:modelValue', 'staging')
    await settle()
    expect(w.find('[data-test="rollback-production-warning"]').exists()).toBe(false)
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.requireTyped).toBeFalsy()
    ui.answer(true)
    await settle()
    expect(calls(invoke, 'jobs:rollback')[0][1]).toBeUndefined()
  })

  it('shows objects and rows of each copy, and leaves structure-only copies unchecked with a warning', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jobs:rollback') return started
      if (channel !== 'jobs:rollbackPlan') return undefined
      const plan = planFor('local')
      Object.assign(plan.items[1], {
        structureOnly: true,
        rows: 0,
        warning:
          'Copia solo de estructura (sin datos): las tablas de «crm» en «Local» quedarán vacías.'
      })
      return plan
    })
    const w = await mountDialog()
    const ui = useUiStore()
    const contents = w.findAll('[data-test="rollback-item-content"]').map((c) => c.text())
    expect(contents).toEqual(['3 objetos · 1.234 filas', '1 objeto · sin datos'])
    const checks = w.findAll('[data-test="rollback-item-check"] input')
    expect((checks[0].element as HTMLInputElement).checked).toBe(true)
    expect((checks[1].element as HTMLInputElement).checked).toBe(false)
    expect(w.get('[data-test="rollback-item-warning"]').text()).toContain('quedarán vacías')
    // Opting in: the confirmation names it under «SIN DATOS».
    await checks[1].setValue(true)
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm.details).toMatch(/quedarán SIN DATOS:\n {2}• crm: Copia solo de estructura/)
    expect(ui.confirm.message).toContain('Reemplazar la base de datos completa')
    ui.answer(false)
    await settle()
  })

  it('shows databases that cannot be restored as disabled with the reason', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel !== 'jobs:rollbackPlan') return undefined
      const plan = planFor('local')
      plan.items[1].problem = 'No se encontró el archivo de la copia: /b/x.nb3'
      return plan
    })
    const w = await mountDialog()
    const checks = w.findAll('[data-test="rollback-item-check"] input')
    expect((checks[1].element as HTMLInputElement).disabled).toBe(true)
    expect((checks[1].element as HTMLInputElement).checked).toBe(false)
    expect(w.get('[data-test="rollback-problem"]').text()).toContain('No se encontró')
  })
})

describe('RollbackDialog with backup files (a package of the backups list)', () => {
  const paths = [
    '/nav/auth/20261005231600-backup-staging.nb3',
    '/nav/crm/20261005231800-backup-staging.nb3'
  ]
  const source = {
    kind: 'files' as const,
    backupPaths: paths,
    sourceConnectionId: 'staging',
    title: 'backup-staging · 2026-10-05 23:16'
  }
  function filesPlan(targetId: string | null): RollbackPlan {
    const plan = planFor(targetId)
    return {
      ...plan,
      source: 'files',
      runId: '',
      jobId: 'manual-rollbacks',
      jobName: source.title,
      items: plan.items.map((item, i) => ({ ...item, taskId: paths[i], backupPath: paths[i] }))
    }
  }

  it('plans the files, lists replaced vs created and sends the file request', async () => {
    const invoke = mockVortaq({
      'jobs:rollbackPlan': (_source: unknown, targetId: unknown) => filesPlan(targetId as string),
      'jobs:rollback': () => started
    })
    const pinia = freshPinia()
    useConnectionsStore().items = [
      makeConnection({ id: 'staging', name: 'Staging', environment: 'staging' }),
      makeConnection({ id: 'local', name: 'Local', environment: 'local' })
    ]
    const w = mountWith(RollbackDialog, pinia, {
      props: { source, modelValue: true }
    } as never)
    await settle()
    expect(calls(invoke, 'jobs:rollbackPlan')).toEqual([
      [
        {
          source: 'files',
          backupPaths: paths,
          sourceConnectionId: 'staging',
          title: source.title
        },
        'local'
      ]
    ])
    expect(w.text()).toContain('Restaurar paquete en Local')
    expect(w.text()).toContain('backup-staging · 2026-10-05 23:16 · 2 copias')
    const ui = useUiStore()
    await w.get('[data-test="rollback-submit"]').trigger('click')
    await settle()
    expect(ui.confirm.message).toContain('de las copias de «backup-staging · 2026-10-05 23:16»')
    expect(ui.confirm.details).toContain('Se REEMPLAZARÁN en «Local»')
    expect(ui.confirm.details!.split('Se crearán')[0]).toContain('• auth')
    expect(ui.confirm.details).toMatch(/Se crearán en «Local»:\n {2}• crm/)
    ui.answer(true)
    await settle()
    expect(calls(invoke, 'jobs:rollback')[0]).toEqual([
      {
        source: 'files',
        backupPaths: paths,
        sourceConnectionId: 'staging',
        title: source.title,
        targetConnectionId: 'local',
        safetyBackup: true,
        includeData: true
      },
      undefined
    ])
    w.unmount()
  })

  it('shows why the files cannot be planned (two copies of one database)', async () => {
    mockVortaq({
      'jobs:rollbackPlan': () => {
        throw new Error(
          'Hay 2 copias de «auth» en la selección (a.nb3, b.nb3); selecciona solo una por base de datos.'
        )
      }
    })
    const pinia = freshPinia()
    useConnectionsStore().items = [makeConnection({ id: 'local', name: 'Local' })]
    const w = mountWith(RollbackDialog, pinia, { props: { source, modelValue: true } } as never)
    await settle()
    expect(w.get('[data-test="rollback-error"]').text()).toContain('selecciona solo una')
    expect(w.get('[data-test="rollback-submit"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('a run source with chosen steps pre-checks only those', async () => {
    const invoke = mockVortaq({
      'jobs:rollbackPlan': (_runId: unknown, targetId: unknown) => planFor(targetId as string)
    })
    const pinia = freshPinia()
    useConnectionsStore().items = [makeConnection({ id: 'local', name: 'Local' })]
    const w = mountWith(RollbackDialog, pinia, {
      props: { source: { kind: 'run', runId: 'run-1', taskIds: ['b2'] }, modelValue: true }
    } as never)
    await settle()
    expect(calls(invoke, 'jobs:rollbackPlan')).toEqual([['run-1', 'local']])
    const checks = w.findAll('[data-test="rollback-item-check"] input')
    expect(checks.map((c) => (c.element as HTMLInputElement).checked)).toEqual([false, true])
    w.unmount()
  })
})

describe('run history entry point', () => {
  it('shows «Restaurar todo en Local» only on finished runs with backups', async () => {
    mockVortaq({ 'jobs:runs': () => [run], 'jobs:rollbackPlan': () => planFor('local') })
    const pinia = freshPinia()
    useJobsStore().runs = [
      run,
      { ...run, id: 'live', status: 'running', startedAt: '2026-10-06T03:00:00.000Z' },
      { ...run, id: 'rb', kind: 'rollback', startedAt: '2026-10-04T03:00:00.000Z' }
    ]
    const w = mountWith(RunHistory, pinia, { props: { jobId: 'job-1' } } as never)
    await settle()
    expect(w.findAll('[data-test="run-rollback"]')).toHaveLength(1)
    expect(w.find('[data-test="run-kind-rollback"]').exists()).toBe(true)
    w.unmount()
  })

  it('cancelling a running restore asks first (the database may stay incomplete)', async () => {
    const invoke = mockVortaq({ 'jobs:runs': () => [], 'jobs:cancel': () => undefined })
    const pinia = freshPinia()
    const live: JobRun = {
      ...run,
      id: 'rb-live',
      status: 'running',
      kind: 'rollback',
      tasks: [
        {
          taskId: 'rollback-b1',
          referenceName: 'Base de datos auth: Staging -> Local',
          status: 'running',
          startedAt: null,
          finishedAt: null,
          message: null,
          outputPath: '/b/local/auth/20261006000000-previo-rollback.nb3',
          type: 'restoreschema',
          connectionId: 'local',
          schema: 'auth'
        }
      ]
    }
    useJobsStore().runs = [live]
    const ui = useUiStore()
    const w = mountWith(RunHistory, pinia, { props: { jobId: 'job-1' } } as never)
    await settle()
    await w.get('[data-test="run-cancel"]').trigger('click')
    await settle()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.message).toContain('«auth» puede quedar borrada o restaurada solo en parte')
    expect(ui.confirm.message).toContain('20261006000000-previo-rollback.nb3')
    ui.answer(false)
    await settle()
    expect(calls(invoke, 'jobs:cancel')).toHaveLength(0)
    await w.get('[data-test="run-cancel"]').trigger('click')
    await settle()
    ui.answer(true)
    await settle()
    expect(calls(invoke, 'jobs:cancel')).toEqual([['rb-live']])
    w.unmount()
  })

  it('a replaced database shows its safety copy with «Deshacer», which opens it in replace mode', async () => {
    const safety = '/b/local/auth/20261006000000-previo-rollback.nb3'
    const file = {
      path: safety,
      fileName: '20261006000000-previo-rollback.nb3',
      connectionId: 'local',
      schema: 'auth',
      sizeBytes: 10,
      createdAt: '2026-10-06T00:00:00.000Z',
      modifiedAt: '2026-10-06T00:00:00.000Z',
      source: 'electrondb',
      label: 'previo-rollback'
    }
    const invoke = mockVortaq({ 'jobs:runs': () => [], 'backups:list': () => [file] })
    const pinia = freshPinia()
    const done: JobRun = {
      ...run,
      id: 'rb-done',
      kind: 'rollback',
      tasks: [
        {
          taskId: 'rollback-b1',
          referenceName: 'Base de datos auth: Staging -> Local',
          status: 'success',
          startedAt: null,
          finishedAt: null,
          message: null,
          outputPath: safety,
          type: 'restoreschema',
          connectionId: 'local',
          schema: 'auth'
        }
      ]
    }
    useJobsStore().runs = [done]
    const ui = useUiStore()
    const w = mountWith(RunHistory, pinia, { props: { jobId: 'job-1' } } as never)
    await settle()
    await w.get('.timeline__card').trigger('click')
    await settle()
    expect(w.get('[data-test="run-safety-copy"]').text()).toContain(
      'Copia previa: 20261006000000-previo-rollback.nb3'
    )
    await w.get('[data-test="run-undo-restore"]').trigger('click')
    await settle()
    expect(calls(invoke, 'backups:list')).toEqual([['local', 'auth']])
    expect(ui.restoreDialog).toMatchObject({ open: true, connectionId: 'local', replace: true })
    expect(ui.restoreDialog.backup?.path).toBe(safety)
    w.unmount()
  })

  it('canRollback and the confirmation text', () => {
    expect(canRollback(run)).toBe(true)
    expect(canRollback({ ...run, tasks: run.tasks.map((t) => ({ ...t, outputPath: null })) })).toBe(
      false
    )
    const text = rollbackConfirmation({
      jobName: 'Backup staging',
      runDate: '05/10/2026 05:00',
      targetName: 'Local',
      items: planFor('local').items,
      safetyBackup: true
    })
    expect(text.title).toBe('Restaurar en «Local»')
    expect(text.message).not.toContain('Solo estructura')
    const structure = rollbackConfirmation({
      jobName: 'Backup staging',
      runDate: '05/10/2026 05:00',
      targetName: 'Local',
      items: planFor('local').items.map((i) => ({ ...i, warning: 'sin filas' })),
      safetyBackup: true,
      includeData: false
    })
    expect(structure.message).toContain('Solo estructura: se crearán las tablas vacías')
    // Every table ends up empty: the per-copy «SIN DATOS» block is not repeated.
    expect(structure.details).not.toContain('SIN DATOS')
    expect(text.message).toMatch(
      /^Se restaurarán 2 bases de datos de la ejecución de «Backup staging»/
    )
    const [full] = planFor('local').items
    expect(contentText(full)).toBe('3 objetos · 1.234 filas')
    expect(selectedByDefault(full)).toBe(true)
    expect(selectedByDefault({ ...full, structureOnly: true })).toBe(false)
    expect(selectedByDefault({ ...full, problem: 'x' })).toBe(false)
    // Runs without pending restore steps cancel without asking.
    expect(cancelRestorePrompt({ ...run, status: 'running' })).toBeNull()
  })

  it('the end toast of a restore run says a safety copy was kept', () => {
    const base = { ...run, kind: 'rollback' as const }
    const task = {
      ...run.tasks[0],
      type: 'restoreschema' as const,
      outputPath: '/b/local/auth/x-previo-rollback.nb3'
    }
    expect(jobOutcome({ ...base, tasks: [task] }).message).toBe(
      'Tarea finalizada · 1 de 1 paso OK · copia previa'
    )
    const failed = jobOutcome({
      ...base,
      status: 'failed',
      tasks: [task, { ...task, status: 'failed' }]
    })
    expect(failed.message).toContain('· 2 copias previas')
  })
})

describe('jobs store and rollback runs', () => {
  it('a rollback never becomes the status of the backup job nor marks it as running', () => {
    freshPinia()
    const jobs = useJobsStore()
    jobs.runs = [
      {
        ...run,
        id: 'rb',
        kind: 'rollback',
        status: 'running',
        startedAt: '2026-10-06T00:00:00.000Z'
      },
      {
        ...run,
        id: 'rb2',
        kind: 'rollback',
        status: 'failed',
        startedAt: '2026-10-05T23:00:00.000Z'
      },
      run
    ]
    expect(jobs.lastRunOf('job-1')?.id).toBe('run-1')
    expect(jobs.runningByJob.has('job-1')).toBe(false)
    // ...but the rollbacks still show in the job's history.
    expect(jobs.runsOf('job-1').map((r) => r.id)).toEqual(['rb', 'rb2', 'run-1'])
  })
})
