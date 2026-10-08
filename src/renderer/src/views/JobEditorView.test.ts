import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Environment, JobInput } from '@shared/types'
import { useTabsStore } from '@renderer/stores/tabs'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import JobEditorView from './JobEditorView.vue'
import {
  buildJobInput,
  emptyDraft,
  newTask,
  validateDraft
} from '@renderer/components/automation/jobForm'
import {
  cronFromForm,
  defaultScheduleForm,
  formFromCron,
  nextRuns
} from '@renderer/components/automation/schedule'
import {
  calls,
  freshPinia,
  makeConnection,
  makeJob,
  mockVortaq,
  mountWith,
  settle
} from '@renderer/components/dialogs/testing'

const job = makeJob({
  id: 'job-1',
  name: 'Nightly',
  tasks: [
    {
      id: 't1',
      type: 'backupschema',
      connectionId: 'c1',
      schema: 'billing',
      referenceName: 'Backup billing',
      includeData: true
    }
  ],
  schedule: { enabled: true, cron: '30 2 * * *', launchAgent: false }
})

describe('schedule builder helpers', () => {
  it('round-trips the friendly presets', () => {
    const base = defaultScheduleForm()
    expect(cronFromForm({ ...base, mode: 'daily', time: '03:05' })).toBe('5 3 * * *')
    expect(cronFromForm({ ...base, mode: 'weekly', time: '22:00', days: [5, 1] })).toBe(
      '0 22 * * 1,5'
    )
    expect(cronFromForm({ ...base, mode: 'monthly', time: '01:30', dayOfMonth: 15 })).toBe(
      '30 1 15 * *'
    )
    expect(cronFromForm({ ...base, mode: 'hourly', everyHours: 6, minuteOfHour: 10 })).toBe(
      '10 */6 * * *'
    )
    expect(formFromCron('10 */6 * * *')).toMatchObject({
      mode: 'hourly',
      everyHours: 6,
      minuteOfHour: 10
    })
    expect(formFromCron('0 22 * * 1,5')).toMatchObject({
      mode: 'weekly',
      days: [1, 5],
      time: '22:00'
    })
    expect(formFromCron('*/15 9-17 * * 1-5')).toMatchObject({ mode: 'custom' })
  })

  it('computes upcoming runs', () => {
    const runs = nextRuns('0 3 * * *', 2, new Date(2026, 0, 1, 12, 0, 0))
    expect(runs.map((d) => [d.getDate(), d.getHours()])).toEqual([
      [2, 3],
      [3, 3]
    ])
    expect(nextRuns('nope', 3)).toEqual([])
  })

  it('keeps cron steps the builder cannot represent as custom instead of clamping them', () => {
    expect(formFromCron('0 */24 * * *')).toMatchObject({
      mode: 'custom',
      expression: '0 */24 * * *'
    })
    expect(cronFromForm(formFromCron('0 */30 * * *'))).toBe('0 */30 * * *')
    expect(cronFromForm(formFromCron('5 */12 * * *'))).toBe('5 */12 * * *')
  })

  it('only requires a schema for backup tasks, like the main process', () => {
    const draft = emptyDraft()
    draft.name = 'Limpieza'
    draft.tasks = [{ ...newTask('runquery', 'c1', ''), sql: 'SELECT 1' }]
    expect(validateDraft(draft)).toEqual([])
    draft.tasks = [newTask('backupschema', 'c1', '')]
    expect(validateDraft(draft)).toContain('Tarea 1: selecciona un esquema.')
  })

  it('builds a valid JobInput and reports Spanish validation errors', () => {
    const draft = emptyDraft()
    expect(validateDraft(draft)).toContain('El nombre de la tarea es obligatorio.')
    draft.name = 'Rollback'
    draft.tasks = [newTask('backupschema', 'c1', 'billing')]
    draft.scheduleEnabled = true
    draft.launchAgent = true
    draft.schedule = { ...defaultScheduleForm(), mode: 'weekly', days: [1], time: '04:00' }
    expect(validateDraft(draft)).toEqual([])
    const input = buildJobInput(draft)
    expect(input).toMatchObject({
      name: 'Rollback',
      continueOnError: true,
      schedule: { enabled: true, cron: '0 4 * * 1', launchAgent: true }
    })
    expect(input.tasks[0]).toMatchObject({
      type: 'backupschema',
      referenceName: 'Backup billing',
      includeData: true
    })
  })
})

describe('JobEditorView', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'connections:list': () => [
        makeConnection({ id: 'c1', name: 'Staging', environment: 'staging' })
      ],
      'connections:open': () => ({ version: '8.4.7' }),
      'db:databases': () => [{ name: 'billing', characterSet: 'utf8mb4', collation: 'x' }],
      'jobs:get': () => job,
      'jobs:save': (input) => ({
        ...job,
        ...(input as JobInput),
        id: 'job-1',
        updatedAt: '2026-10-05T00:00:00.000Z'
      }),
      'jobs:runs': () => []
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountEditor(jobId: string | null, typed?: Environment[]) {
    const pinia = freshPinia()
    if (typed) useSettingsStore().settings.typedConfirmEnvironments = typed
    const tabs = useTabsStore()
    const tab = tabs.open({ kind: 'jobEditor', title: 'Tarea', payload: { jobId } })
    wrapper = mountWith(JobEditorView, pinia, { props: { tab } })
    await settle()
    return { w: wrapper, tabs, tab }
  }

  it('saves a JobInput whose cron comes from the schedule builder and tracks dirty state', async () => {
    const { w, tabs, tab } = await mountEditor('job-1')
    expect(tabs.tabs.find((t) => t.id === tab.id)?.dirty).toBe(false)

    await w.get('[data-test="schedule-time"] input').setValue('04:15')
    await w.get('[data-test="job-name"] input').setValue('Nightly billing')
    await settle()
    expect(w.get('[data-test="schedule-cron"]').text()).toBe('15 4 * * *')
    expect(tabs.tabs.find((t) => t.id === tab.id)?.dirty).toBe(true)

    await w.get('[data-test="job-save"]').trigger('click')
    await settle()
    const [[input]] = calls(invoke, 'jobs:save') as [[JobInput]]
    expect(input).toMatchObject({
      id: 'job-1',
      name: 'Nightly billing',
      schedule: { enabled: true, cron: '15 4 * * *', launchAgent: false }
    })
    expect(input.tasks).toHaveLength(1)
    const saved = tabs.tabs.find((t) => t.id === tab.id)
    expect(saved?.dirty).toBe(false)
    expect(saved?.title).toBe('Nightly billing (Automatización)')
  })

  it('offers "Ejecutar aunque la app esté cerrada" on macOS', async () => {
    const { w } = await mountEditor('job-1')
    expect(w.find('[data-test="job-launch-agent-unsupported"]').exists()).toBe(false)
    const input = w.get('[data-test="job-launch-agent"] input')
    expect((input.element as HTMLInputElement).disabled).toBe(false)
  })

  for (const os of ['win32', 'linux']) {
    it(`disables the launchd switch on ${os} and explains Task Scheduler/cron`, async () => {
      ;(window.vortaq as { platform?: string }).platform = os
      const { w } = await mountEditor('job-1')
      const block = w.get('[data-test="job-launch-agent-unsupported"]')
      expect((block.get('input').element as HTMLInputElement).disabled).toBe(true)
      expect(block.text()).toContain('Solo en macOS')
      expect(block.text()).toContain('--run-job')
    })
  }

  it('does not open connections just to show the schema dropdowns', async () => {
    await mountEditor('job-1')
    expect(calls(invoke, 'connections:open')).toHaveLength(0)
    expect(calls(invoke, 'db:databases')).toHaveLength(0)
  })

  it('stores the new job id in the tab payload after the first save', async () => {
    const { w, tabs, tab } = await mountEditor(null)
    expect(tabs.tabs.find((t) => t.id === tab.id)?.dirty).toBe(false)
    await w.get('[data-test="job-name"] input').setValue('Nightly')
    await w.get('[data-test="add-backup-task"]').trigger('click')
    await settle()
    // Fill the task through the model to avoid driving Vuetify selects.
    const tasksEditor = w.findComponent({ name: 'JobTasksEditor' })
    const current = tasksEditor.props('modelValue') as { connectionId: string; schema: string }[]
    tasksEditor.vm.$emit('update:modelValue', [
      { ...current[0], connectionId: 'c1', schema: 'billing' }
    ])
    await settle()
    await w.get('[data-test="job-save"]').trigger('click')
    await settle()
    expect(calls(invoke, 'jobs:save')).toHaveLength(1)
    expect(tabs.tabs.find((t) => t.id === tab.id)?.payload?.jobId).toBe('job-1')
  })

  it('a restore step shows «Contenido» (default «Estructura y datos», also for older steps) and saves «Solo estructura»', async () => {
    const legacy = makeJob({
      id: 'job-1',
      name: 'Staging -> Local',
      tasks: [
        job.tasks[0],
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: 'l1',
          schema: '',
          referenceName: 'Restaurar billing',
          restoreSource: { kind: 'task', taskId: 't1' },
          safetyBackup: true
        }
      ],
      schedule: { enabled: false, cron: '', launchAgent: false }
    })
    invoke = mockVortaq({
      'connections:list': () => [
        makeConnection({ id: 'c1', name: 'Staging', environment: 'staging' }),
        makeConnection({ id: 'l1', name: 'Local', environment: 'local' })
      ],
      'jobs:get': () => legacy,
      'jobs:save': (input) => ({ ...legacy, ...(input as JobInput), id: 'job-1' }),
      'jobs:runs': () => []
    })
    const { w } = await mountEditor('job-1')
    const content = w.get('[data-test="restore-content"]')
    expect(content.text()).toContain('Contenido')
    expect(content.get('[data-test="replace-content-data"]').classes()).toContain('v-btn--active')
    expect(content.get('[data-test="replace-content-hint"]').text()).toBe(
      'Todos los objetos de la copia con todas sus filas'
    )
    await content.get('[data-test="replace-content-structure"]').trigger('click')
    await settle()
    expect(w.get('[data-test="replace-content-hint"]').text()).toBe(
      'Tablas con sus relaciones (claves foráneas, índices), vistas, rutinas, eventos y disparadores, sin filas'
    )
    await w.get('[data-test="job-save"]').trigger('click')
    await settle()
    const [[input]] = calls(invoke, 'jobs:save') as [[JobInput]]
    expect(input.tasks[1]).toMatchObject({ type: 'restoreschema', includeData: false })
  })

  it('a backup step offers «Formato: .nb3 | .sql» and saves .sql with its hint', async () => {
    const { w } = await mountEditor('job-1')
    const toggle = w.get('[data-test="task-format"]')
    expect(toggle.get('[data-test="task-format-nb3"]').classes()).toContain('v-btn--active')
    expect(w.find('[data-test="task-format-hint"]').exists()).toBe(false)
    await toggle.get('[data-test="task-format-sql"]').trigger('click')
    await settle()
    expect(w.get('[data-test="task-format-hint"]').text()).toContain(
      'Las restauraciones automáticas necesitan .nb3'
    )
    await w.get('[data-test="job-save"]').trigger('click')
    await settle()
    const [[input]] = calls(invoke, 'jobs:save') as [[JobInput]]
    expect(input.tasks[0]).toMatchObject({ type: 'backupschema', format: 'sql' })
  })

  it('asks for confirmation before running SQL on a production connection', async () => {
    invoke = mockVortaq({
      'connections:list': () => [
        makeConnection({ id: 'p1', name: 'Prod', environment: 'production' })
      ],
      'settings:get': () => ({ typedConfirmEnvironments: ['production'] }),
      'jobs:get': () =>
        makeJob({
          id: 'job-2',
          name: 'Purge',
          tasks: [
            {
              id: 't1',
              type: 'runquery',
              connectionId: 'p1',
              schema: 'app',
              referenceName: 'q',
              sql: 'DELETE FROM x'
            }
          ]
        }),
      'jobs:runs': () => []
    })
    const { w } = await mountEditor('job-2')
    const ui = useUiStore()
    const ask = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    await w.get('[data-test="job-run"]').trigger('click')
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({ requireTyped: 'Prod', production: true })
    expect(calls(invoke, 'jobs:run')).toHaveLength(0)
  })

  function stagingSqlJob() {
    return mockVortaq({
      'connections:list': () => [makeConnection({ id: 's1', name: 'Pre', environment: 'staging' })],
      'jobs:get': () =>
        makeJob({
          id: 'job-3',
          name: 'Purge',
          tasks: [
            {
              id: 't1',
              type: 'runquery',
              connectionId: 's1',
              schema: 'app',
              referenceName: 'q',
              sql: 'DELETE FROM x'
            }
          ]
        }),
      'jobs:runs': () => [],
      'jobs:run': () => ({ id: 'run-1' })
    })
  }

  it('asks for the typed name before running SQL on a staging connection listed in Ajustes', async () => {
    invoke = stagingSqlJob()
    const { w } = await mountEditor('job-3', ['production', 'staging'])
    const ui = useUiStore()
    const ask = vi.spyOn(ui, 'ask').mockResolvedValue(true)
    await w.get('[data-test="job-run"]').trigger('click')
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({
      requireTyped: 'Pre',
      production: true,
      typedEnvironment: 'staging',
      title: 'Ejecutar tarea en «Pre»'
    })
    expect(ask.mock.calls[0][0].message).toContain('«Pre» (entorno Staging)')
    expect(calls(invoke, 'jobs:run')).toEqual([['job-3', { confirmProduction: true }]])
  })

  it('runs SQL on a staging connection that is not listed without the typed name', async () => {
    invoke = stagingSqlJob()
    const { w } = await mountEditor('job-3')
    const ask = vi.spyOn(useUiStore(), 'ask')
    await w.get('[data-test="job-run"]').trigger('click')
    await settle()
    expect(ask).not.toHaveBeenCalled()
    expect(calls(invoke, 'jobs:run')).toHaveLength(1)
  })

  it('does not call jobs:save for an incomplete new job', async () => {
    const { w } = await mountEditor(null)
    await w.get('[data-test="job-save"]').trigger('click')
    await settle()
    expect(w.get('[data-test="job-errors"]').text()).toContain('obligatorio')
    expect(calls(invoke, 'jobs:save')).toHaveLength(0)
  })
})
