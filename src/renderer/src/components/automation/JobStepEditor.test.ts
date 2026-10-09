import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { Job, JobInput, JobTask } from '@shared/types'
import { useTabsStore } from '@renderer/stores/tabs'
import JobEditorView from '@renderer/views/JobEditorView.vue'
import {
  calls,
  freshPinia,
  makeConnection,
  makeJob,
  mockVortaq,
  mountWith,
  settle
} from '@renderer/components/dialogs/testing'
import {
  backupStep,
  connectionsForKind,
  isHiddenDatabase,
  restoreFromLatest,
  savedQueriesFor,
  savedQueryStep
} from './jobSteps'
import { duplicateTask, problemsByTask } from './jobForm'

const mysql = makeConnection({ id: 'c1', name: 'Staging', environment: 'staging' })
const local = makeConnection({ id: 'l1', name: 'Local', environment: 'local' })
const prod = makeConnection({ id: 'p1', name: 'Prod', environment: 'production' })
const pg = makeConnection({ id: 'pg', name: 'Postgres', engine: 'postgresql', port: 5432 })
const mongo = makeConnection({ id: 'mg', name: 'Mongo', engine: 'mongodb', port: 27017 })

describe('job step browser model', () => {
  it('offers query kinds only on MySQL/MariaDB and backups on every engine', () => {
    const all = [mysql, pg, mongo]
    expect(connectionsForKind('backup', all).map((c) => c.id)).toEqual(['c1', 'pg', 'mg'])
    expect(connectionsForKind('savedQuery', all).map((c) => c.id)).toEqual(['c1'])
    expect(connectionsForKind('sql', all).map((c) => c.id)).toEqual(['c1'])
  })

  it('hides system databases per engine', () => {
    expect(isHiddenDatabase(mysql, 'performance_schema')).toBe(true)
    expect(isHiddenDatabase(mysql, 'shop')).toBe(false)
    expect(isHiddenDatabase(pg, 'template1')).toBe(true)
    expect(isHiddenDatabase(mongo, 'admin')).toBe(true)
    expect(isHiddenDatabase(mongo, 'tienda')).toBe(false)
  })

  it('builds steps: .vqb copies off MySQL, saved query SQL copied with its name', () => {
    expect(backupStep(pg, 'app')).toMatchObject({
      type: 'backupschema',
      format: 'vqb',
      schema: 'app'
    })
    const step = savedQueryStep(
      mysql,
      { id: 'q1', name: 'Purgar', sql: 'DELETE FROM t', schema: 'shop', updatedAt: '' },
      null
    )
    expect(step).toMatchObject({
      type: 'runquery',
      connectionId: 'c1',
      schema: 'shop',
      sql: 'DELETE FROM t',
      referenceName: 'Purgar'
    })
    expect(
      savedQueriesFor(
        [
          { id: 'a', name: 'b', sql: '', schema: 'x', updatedAt: '' },
          { id: 'b', name: 'a', sql: '', schema: 'y', updatedAt: '' }
        ],
        'x'
      ).map((q) => q.id)
    ).toEqual(['a'])
  })

  it('a restore from the latest copy targets a local connection of the same engine, never a guarded one', () => {
    const blocked = (c: { environment: string }) => c.environment === 'production'
    const task = restoreFromLatest(mysql, 'shop', [prod, pg, local], blocked)
    expect(task).toMatchObject({
      type: 'restoreschema',
      connectionId: 'l1',
      restoreSource: { kind: 'latest', connectionId: 'c1', schema: 'shop' }
    })
  })

  it('duplicates a step with a new id and reports problems per step', () => {
    const t: JobTask = {
      id: 'x',
      type: 'runquery',
      connectionId: 'c1',
      schema: '',
      referenceName: '',
      sql: ''
    }
    const copy = duplicateTask(t)
    expect(copy.id).not.toBe('x')
    expect(problemsByTask([t, copy], () => mysql)).toEqual({
      x: ['Paso 1: escribe la consulta SQL a ejecutar.'],
      [copy.id]: ['Paso 2: escribe la consulta SQL a ejecutar.']
    })
  })
})

describe('job editor: sequence, browser and settings', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null
  let current: Job

  function steps(): JobTask[] {
    return [
      {
        id: 'b1',
        type: 'backupschema',
        connectionId: 'c1',
        schema: 'shop',
        referenceName: 'Backup shop',
        includeData: true,
        format: 'vqb'
      },
      {
        id: 'b2',
        type: 'backupschema',
        connectionId: 'c1',
        schema: 'crm',
        referenceName: 'Backup crm',
        includeData: true
      },
      {
        id: 'q1',
        type: 'runquery',
        connectionId: 'c1',
        schema: 'shop',
        referenceName: 'Limpiar',
        sql: 'DELETE FROM tmp'
      }
    ]
  }

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(
      'electrondb.queries.c1',
      JSON.stringify([
        {
          id: 'sq1',
          name: 'Cerrar pedidos',
          sql: "UPDATE pedidos SET estado = 'cerrado'",
          schema: 'shop',
          updatedAt: ''
        },
        { id: 'sq2', name: 'Informe CRM', sql: 'SELECT 1', schema: 'crm', updatedAt: '' }
      ])
    )
    current = makeJob({
      id: 'job-1',
      name: 'Nocturna',
      tasks: steps(),
      schedule: { enabled: false, cron: '0 3 * * *', launchAgent: false }
    })
    invoke = mockVortaq({
      'connections:list': () => [mysql, local, prod, pg],
      'connections:open': () => ({ version: '8.4.7' }),
      'db:databases': () =>
        ['shop', 'crm', 'mysql', 'information_schema'].map((name) => ({
          name,
          characterSet: 'utf8mb4',
          collation: 'x'
        })),
      'jobs:get': () => current,
      'jobs:save': (input) => ({ ...current, ...(input as JobInput), id: 'job-1' }),
      'jobs:runs': () => [],
      'backups:list': () => []
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountEditor(jobId: string | null = 'job-1') {
    const pinia = freshPinia()
    const tab = useTabsStore().open({ kind: 'jobEditor', title: 'Tarea', payload: { jobId } })
    wrapper = mountWith(JobEditorView, pinia, { props: { tab } })
    await settle()
    return wrapper
  }

  async function saved(w: NonNullable<typeof wrapper>): Promise<JobInput> {
    await w.get('[data-test="job-save"]').trigger('click')
    await settle()
    const all = calls(invoke, 'jobs:save') as [JobInput][]
    return all[all.length - 1][0]
  }

  const rowNames = (w: NonNullable<typeof wrapper>) =>
    w.findAll('[data-test^="job-task-"]').map((r) => r.text())

  it('lists each step with its type, connection, environment, database and detail', async () => {
    const w = await mountEditor()
    const first = w.get('[data-test="job-task-0"]')
    expect(first.text()).toContain('Copia')
    expect(first.text()).toContain('Backup shop')
    expect(first.text()).toContain('Staging')
    expect(first.text()).toContain('shop')
    expect(first.get('[data-test="step-detail"]').text()).toBe('.vqb')
    expect(w.get('[data-test="job-task-1"] [data-test="step-detail"]').text()).toBe('.nb3')
    expect(w.get('[data-test="job-task-2"] [data-test="step-detail"]').text()).toBe(
      'DELETE FROM tmp'
    )
  })

  it('reorders with the row buttons and Alt+arrows, duplicates and removes', async () => {
    const w = await mountEditor()
    await w.get('[data-test="step-down-0"]').trigger('click')
    await settle()
    expect(rowNames(w)[0]).toContain('Backup crm')
    await w.get('[data-test="job-task-2"]').trigger('keydown', { key: 'ArrowUp', altKey: true })
    await settle()
    expect(rowNames(w)[1]).toContain('Limpiar')
    await w.get('[data-test="step-duplicate-1"]').trigger('click')
    await settle()
    expect(rowNames(w)).toHaveLength(4)
    await w.get('[data-test="step-remove-2"]').trigger('click')
    await w.get('[data-test="job-task-0"]').trigger('keydown', { key: 'Delete' })
    await settle()
    const input = await saved(w)
    expect(input.tasks.map((t) => t.referenceName)).toEqual(['Limpiar', 'Backup shop'])
  })

  it('reorders by dragging a row onto another', async () => {
    const w = await mountEditor()
    const store = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      setData: (type: string, value: string) => {
        store.set(type, value)
        dataTransfer.types.push(type)
      },
      getData: (type: string) => store.get(type) ?? '',
      effectAllowed: '',
      dropEffect: ''
    }
    await w.get('[data-test="job-task-2"]').trigger('dragstart', { dataTransfer })
    const target = w.get('[data-test="job-task-0"]')
    // Upper half of the first row: insert before it.
    target.element.getBoundingClientRect = () => ({
      top: 0,
      height: 40,
      bottom: 40,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => null
    })
    await target.trigger('dragover', { dataTransfer, clientY: 5 })
    await w.get('[data-test="step-list"]').trigger('drop', { dataTransfer })
    await settle()
    expect(rowNames(w)[0]).toContain('Limpiar')
  })

  it('opens the settings of a step and saves its edits', async () => {
    const w = await mountEditor()
    expect(w.find('[data-test="step-settings"]').exists()).toBe(false)
    await w.get('[data-test="job-task-1"]').trigger('click')
    await settle()
    const panel = w.get('[data-test="step-settings"]')
    expect(panel.text()).toContain('Paso 2')
    await panel.get('[data-test="step-reference"] input').setValue('Copia CRM')
    await panel.get('[data-test="task-include-data"] input').setValue(false)
    await panel.get('[data-test="task-format-vqb"]').trigger('click')
    await settle()
    await w.get('[data-test="task-encrypt"] input').setValue(true)
    await settle()
    expect(w.get('[data-test="task-encrypt-hint"]').text()).toContain('Falta la contraseña')
    await w.get('[data-test="task-encrypt-options"]').trigger('click')
    await settle()
    expect(w.get('[data-test="job-section-options"]').attributes('aria-selected')).toBe('true')
    await w.get('[data-test="job-backup-password-input"] input').setValue('secreto-largo')
    await w.get('[data-test="job-backup-password-again"] input').setValue('secreto-largo')
    const input = await saved(w)
    expect(input.tasks[1]).toMatchObject({
      referenceName: 'Copia CRM',
      includeData: false,
      format: 'vqb',
      encrypt: true
    })
    expect(input.backupPassword).toBe('secreto-largo')
    // Esc closes the panel.
    await w.get('[data-test="job-section-steps"]').trigger('click')
    await w.get('[data-test="job-task-0"]').trigger('click')
    await settle()
    await w.get('[data-test="step-settings"]').trigger('keydown', { key: 'Escape' })
    await settle()
    expect(w.find('[data-test="step-settings"]').exists()).toBe(false)
  })

  it('shows step problems on the row and opens the first failing step on save', async () => {
    current = makeJob({
      ...current,
      tasks: [
        ...steps(),
        {
          id: 'q2',
          type: 'runquery',
          connectionId: 'c1',
          schema: '',
          referenceName: 'Vacía',
          sql: ''
        }
      ]
    })
    const w = await mountEditor()
    const row = w.get('[data-test="job-task-3"]')
    expect(row.get('[data-test="step-problem"]').text()).toContain('escribe la consulta SQL')
    expect(row.classes()).not.toContain('step-row--strict')
    await w.get('[data-test="job-save"]').trigger('click')
    await settle()
    expect(calls(invoke, 'jobs:save')).toHaveLength(0)
    expect(w.get('[data-test="job-task-3"]').classes()).toContain('step-row--strict')
    expect(w.get('[data-test="step-settings-problems"]').text()).toContain('Paso 4')
    expect(w.get('[data-test="job-errors"]').text()).toContain('Paso 4')
  })

  it('adds several databases at once, hiding the system ones, only after the user picks a connection', async () => {
    const w = await mountEditor()
    expect(calls(invoke, 'connections:open')).toHaveLength(0)
    await w.get('[data-test="browse-connection-c1"]').trigger('click')
    await settle()
    expect(calls(invoke, 'connections:open')).toHaveLength(1)
    const items = w.get('[data-test="step-browser-items"]')
    expect(items.text()).toContain('shop')
    expect(items.find('[data-test="avail-backup:c1:mysql"]').exists()).toBe(false)
    expect(items.find('[data-test="avail-backup:c1:information_schema"]').exists()).toBe(false)
    expect(items.get('[data-test="avail-backup:c1:shop"]').text()).toContain('ya en la tarea')
    expect((w.get('[data-test="browser-add"]').element as HTMLButtonElement).disabled).toBe(true)
    await items.get('[data-test="avail-backup:c1:shop"]').trigger('keydown', { key: ' ' })
    await items.get('[data-test="avail-backup:c1:crm"]').trigger('keydown', { key: ' ' })
    await settle()
    expect(w.get('[data-test="browser-add"]').text()).toContain('Añadir (2)')
    await w.get('[data-test="browser-add"]').trigger('click')
    await settle()
    expect(rowNames(w)).toHaveLength(5)
    // Several steps at once do not open a settings panel; they are announced.
    expect(w.find('[data-test="step-settings"]').exists()).toBe(false)
    expect(w.text()).toContain('2 pasos añadidos')
  })

  it('adds a saved query of the selected database with a double click (no connection opened)', async () => {
    const w = await mountEditor()
    await w.get('[data-test="step-kind-savedQuery"]').trigger('click')
    await settle()
    // Postgres has no query steps.
    expect(w.find('[data-test="browse-connection-pg"]').exists()).toBe(false)
    await w.get('[data-test="browse-connection-c1"]').trigger('click')
    await settle()
    expect(calls(invoke, 'connections:open')).toHaveLength(0)
    const items = w.get('[data-test="step-browser-items"]')
    expect(items.text()).toContain('Cerrar pedidos')
    expect(items.text()).toContain('Informe CRM')
    await w.get('[data-test="browse-expand-c1"]').trigger('click')
    await settle()
    await w.get('[data-test="browse-db-crm"]').trigger('click')
    await settle()
    expect(w.get('[data-test="step-browser-items"]').text()).not.toContain('Cerrar pedidos')
    await w.get('[data-test="avail-query:c1:sq2"]').trigger('dblclick')
    await settle()
    const input = await saved(w)
    expect(input.tasks[3]).toMatchObject({
      type: 'runquery',
      connectionId: 'c1',
      schema: 'crm',
      sql: 'SELECT 1',
      referenceName: 'Informe CRM'
    })
  })

  it('adds a restore of an earlier backup step into a local target, and drags items into place', async () => {
    const w = await mountEditor()
    await w.get('[data-test="step-kind-restore"]').trigger('click')
    await settle()
    const item = w.get('[data-test="avail-step:b1"]')
    // Names the copy, its connection and content, and where it lands by default.
    expect(item.text()).toContain('Copia de shop (Staging) — estructura y datos')
    expect(item.text()).toContain('Paso 1 · .vqb · se restaura en Local con copia previa')
    const types: string[] = []
    const dataTransfer = {
      types,
      setData: (type: string) => types.push(type),
      getData: () => '',
      effectAllowed: '',
      dropEffect: ''
    }
    await item.trigger('dragstart', { dataTransfer })
    const target = w.get('[data-test="job-task-2"]')
    target.element.getBoundingClientRect = () => ({
      top: 0,
      height: 40,
      bottom: 40,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => null
    })
    await target.trigger('dragover', { dataTransfer, clientY: 5 })
    await w.get('[data-test="step-list"]').trigger('drop', { dataTransfer })
    await settle()
    expect(rowNames(w)[2]).toContain('Restauración')
    const input = await saved(w)
    expect(input.tasks[2]).toMatchObject({
      type: 'restoreschema',
      connectionId: 'l1',
      restoreSource: { kind: 'task', taskId: 'b1' },
      safetyBackup: true
    })
    // The dropped step is selected: its settings show the chosen target.
    expect(w.get('[data-test="restore-target"]').text()).toContain('Local')
  })

  it('«Seleccionar todo» checks every database of the list (tri-state) and adds them', async () => {
    current = makeJob({ ...current, tasks: [] })
    const w = await mountEditor()
    await w.get('[data-test="browse-connection-c1"]').trigger('click')
    await settle()
    const all = () => w.get('[data-test="browser-select-all-dbs"] input')
    expect((all().element as HTMLInputElement).checked).toBe(false)
    await w.get('[data-test="avail-backup:c1:shop"]').trigger('keydown', { key: ' ' })
    await settle()
    expect(all().attributes('aria-checked')).toBe('mixed')
    expect(w.get('[data-test="browser-select-all-dbs"]').text()).toContain('(1/2)')
    await all().setValue(true)
    await settle()
    expect(w.get('[data-test="browser-add"]').text()).toContain('Añadir (2)')
    await all().setValue(false)
    await settle()
    expect((w.get('[data-test="browser-add"]').element as HTMLButtonElement).disabled).toBe(true)
    await all().setValue(true)
    await settle()
    await w.get('[data-test="browser-add"]').trigger('click')
    await settle()
    const input = await saved(w)
    expect(input.tasks.map((t) => [t.type, t.schema, t.referenceName])).toEqual([
      ['backupschema', 'shop', 'Copia de shop (Staging)'],
      ['backupschema', 'crm', 'Copia de crm (Staging)']
    ])
  })

  it('«Todas las bases de datos» adds one copy per database not yet in the job, once', async () => {
    const w = await mountEditor()
    await w.get('[data-test="browse-connection-c1"]').trigger('click')
    await settle()
    const item = w.get('[data-test="avail-backup-all:c1"]')
    expect(item.text()).toContain('Todas las bases de datos de Staging')
    // shop and crm are both in the job already.
    expect(item.text()).toContain('ya en la tarea')
    current = makeJob({ ...current, tasks: [steps()[0]] })
    const w2 = await mountEditor()
    await w2.get('[data-test="browse-connection-c1"]').trigger('click')
    await settle()
    const item2 = w2.get('[data-test="avail-backup-all:c1"]')
    expect(item2.text()).toContain('1 ya en la tarea: se añade la que falta')
    // Checked together with crm itself: crm is added once.
    await item2.trigger('keydown', { key: ' ' })
    await w2.get('[data-test="avail-backup:c1:crm"]').trigger('keydown', { key: ' ' })
    await w2.get('[data-test="browser-add"]').trigger('click')
    await settle()
    const input = await saved(w2)
    expect(input.tasks.map((t) => t.schema)).toEqual(['shop', 'crm'])
  })

  it('restore lists: latest copies name their connection; with no copies it offers «Copiar y restaurar»', async () => {
    current = makeJob({ ...current, tasks: [] })
    const w = await mountEditor()
    await w.get('[data-test="step-kind-restore"]').trigger('click')
    await settle()
    expect(w.get('[data-test="browser-recipe-suggest"]').text()).toContain('Copiar y restaurar')
    await w.get('[data-test="browse-connection-c1"]').trigger('click')
    await settle()
    const items = w.get('[data-test="step-browser-items"]')
    expect(items.text()).toContain('Copias en disco de Staging')
    expect(items.get('[data-test="avail-latest:c1:shop"]').text()).toContain(
      'Última copia de shop · Staging'
    )
    await w.get('[data-test="browser-recipe-suggest-open"]').trigger('click')
    await settle()
    // The selected connection is proposed as origin.
    expect(w.get('[data-test="recipe-databases"]').text()).toContain('shop')
  })

  it('«Copiar y restaurar» adds the copies and then the restores of every database, with or without safety copy', async () => {
    current = makeJob({ ...current, tasks: [] })
    const w = await mountEditor()
    expect(w.find('[data-test="copy-restore-dialog"]').exists()).toBe(false)
    await w.get('[data-test="step-list-recipe-open"]').trigger('click')
    await settle()
    const dialog = () => w.get('[data-test="copy-restore-dialog"]')
    // Nothing is opened until the user picks the origin.
    expect(calls(invoke, 'connections:open')).toHaveLength(0)
    expect((w.get('[data-test="recipe-add"]').element as HTMLButtonElement).disabled).toBe(true)
    const source = w
      .findAllComponents({ name: 'VSelect' })
      .find((c) => c.attributes('data-test') === 'recipe-source')!
    source.vm.$emit('update:modelValue', 'c1')
    await settle()
    expect(calls(invoke, 'connections:open')).toHaveLength(1)
    // Every database (system ones excluded) is checked; the target is the local connection.
    expect(dialog().get('[data-test="recipe-count"]').text()).toBe('2/2')
    expect(dialog().text()).not.toContain('information_schema')
    // One «Restaurar paquete» step by default; one restore per database on request.
    expect(dialog().get('[data-test="recipe-summary"]').text()).toBe(
      'Añadirá 3 pasos: 2 copias de Staging y, después, un paso «Restaurar paquete» que las restaura en Local con copia previa.'
    )
    await dialog().get('[data-test="recipe-restore-steps"]').trigger('click')
    await settle()
    expect(dialog().get('[data-test="recipe-summary"]').text()).toBe(
      'Añadirá 4 pasos: 2 copias de Staging y, después, 2 restauraciones en Local con copia previa.'
    )
    // crm goes to crm_copia; no safety copy.
    await dialog().get('[data-test="recipe-target-crm"] input').setValue('crm_copia')
    await dialog().get('[data-test="recipe-safety-off"]').trigger('click')
    await settle()
    expect(dialog().get('[data-test="recipe-safety-hint"]').text()).toContain(
      'se reemplazan directamente'
    )
    expect(w.get('[data-test="recipe-add"]').text()).toContain('Añadir 4 pasos')
    await w.get('[data-test="recipe-add"]').trigger('click')
    await settle()
    expect(w.find('[data-test="copy-restore-dialog"]').exists()).toBe(false)
    expect(rowNames(w)[0]).toContain('Copia de shop (Staging)')
    expect(rowNames(w)[2]).toContain('Restaurar shop en Local')
    expect(w.get('[data-test="job-task-3"] [data-test="step-detail"]').text()).toBe(
      'desde copia del paso 2 (crm) · sin copia previa'
    )
    await w.get('[data-test="job-name"] input').setValue('Staging a Local')
    const input = await saved(w)
    const [b1, b2, r1, r2] = input.tasks
    expect(input.tasks.map((t) => t.type)).toEqual([
      'backupschema',
      'backupschema',
      'restoreschema',
      'restoreschema'
    ])
    expect(b1).toMatchObject({
      connectionId: 'c1',
      schema: 'shop',
      format: 'vqb',
      includeData: true
    })
    expect(r1).toMatchObject({
      connectionId: 'l1',
      schema: '',
      referenceName: 'Restaurar shop en Local',
      restoreSource: { kind: 'task', taskId: b1.id },
      safetyBackup: false,
      includeData: true
    })
    expect(r2).toMatchObject({
      schema: 'crm_copia',
      referenceName: 'Restaurar crm_copia en Local',
      restoreSource: { kind: 'task', taskId: b2.id }
    })
  })

  it('«Copiar y restaurar» as one «Restaurar paquete» step keeps the per-database names', async () => {
    current = makeJob({ ...current, tasks: [] })
    const w = await mountEditor()
    await w.get('[data-test="step-list-recipe-open"]').trigger('click')
    await settle()
    const dialog = () => w.get('[data-test="copy-restore-dialog"]')
    w.findAllComponents({ name: 'VSelect' })
      .find((c) => c.attributes('data-test') === 'recipe-source')!
      .vm.$emit('update:modelValue', 'c1')
    await settle()
    await dialog().get('[data-test="recipe-target-crm"] input').setValue('crm_copia')
    await settle()
    expect(w.get('[data-test="recipe-add"]').text()).toContain('Añadir 3 pasos')
    await w.get('[data-test="recipe-add"]').trigger('click')
    await settle()
    expect(rowNames(w)).toHaveLength(3)
    expect(rowNames(w)[2]).toContain('Restaurar paquete de esta tarea en Local')
    expect(w.get('[data-test="job-task-2"] [data-test="step-detail"]').text()).toBe(
      '2 bases elegidas · con copia previa'
    )
    await w.get('[data-test="job-name"] input').setValue('Staging a Local')
    const input = await saved(w)
    expect(input.tasks.map((t) => t.type)).toEqual([
      'backupschema',
      'backupschema',
      'restorepackage'
    ])
    expect(input.tasks[2]).toMatchObject({
      connectionId: 'l1',
      referenceName: 'Restaurar paquete de esta tarea en Local',
      packageSource: { kind: 'own' },
      packageDatabases: ['shop', 'crm'],
      packageTargets: { crm: 'crm_copia' },
      safetyBackup: true,
      includeData: true
    })
  })

  it('restore list: this job as one package, other automations by their latest package', async () => {
    invoke = mockVortaq({
      'connections:list': () => [mysql, local, prod, pg],
      'jobs:get': () => current,
      'jobs:save': (input) => ({ ...current, ...(input as JobInput), id: 'job-1' }),
      'jobs:runs': () => [],
      'backups:list': () => [],
      'jobs:packages': () => [
        {
          jobId: 'job-1',
          jobName: 'Nocturna',
          steps: [{ schema: 'shop', connectionId: 'c1', includeData: true }],
          latest: null
        },
        {
          jobId: 'job-2',
          jobName: 'Copia nocturna Staging',
          steps: [],
          latest: {
            runId: 'run-9',
            startedAt: '2026-10-07T02:00:00.000Z',
            status: 'success',
            copies: ['auth', 'ventas', 'logs'].map((schema, i) => ({
              schema,
              connectionId: 'c1',
              taskId: `t${i}`,
              path: `/b/${schema}.vqb`,
              structureOnly: schema === 'logs',
              encrypted: false
            }))
          }
        }
      ]
    })
    const w = await mountEditor()
    await w.get('[data-test="step-kind-restore"]').trigger('click')
    await settle()
    const items = w.get('[data-test="step-browser-items"]')
    // This job: a package header with its two restorable copies inside.
    const own = items.get('[data-test="avail-pack:own"]')
    expect(own.text()).toContain('Paquete de esta tarea · 2 copias')
    expect(own.text()).toContain('Staging')
    expect(own.text()).toContain('Se restaura en Local con copia previa · un paso con todas')
    expect(items.find('[data-test="avail-step:b1"]').exists()).toBe(true)
    // The other automation, folded, with its latest package; never the job itself.
    const other = items.get('[data-test="avail-pack:job:job-2"]')
    expect(other.text()).toContain('Copia nocturna Staging · último paquete (')
    expect(other.text()).toContain('3 copias)')
    expect(items.find('[data-test="avail-pack:job:job-1"]').exists()).toBe(false)
    expect(items.find('[data-test="avail-pkg:job-2:auth"]').exists()).toBe(false)
    await items.get('[data-test="pack-fold-job:job-2"]').trigger('click')
    await settle()
    expect(items.get('[data-test="avail-pkg:job-2:logs"]').text()).toContain('solo estructura')

    // The whole package of this job is ONE step.
    await items.get('[data-test="avail-add-pack:own"]').trigger('click')
    await settle()
    expect(rowNames(w)).toHaveLength(4)
    expect(rowNames(w)[3]).toContain('Restaurar paquete de esta tarea en Local')
    expect(w.get('[data-test="job-task-3"] [data-test="step-detail"]').text()).toBe(
      '2 bases (todas) · con copia previa'
    )
    // Two databases of the other package checked: one package step with just those.
    await w.get('[data-test="avail-pkg:job-2:auth"]').trigger('keydown', { key: ' ' })
    await w.get('[data-test="avail-pkg:job-2:ventas"]').trigger('keydown', { key: ' ' })
    await settle()
    expect(w.get('[data-test="browser-add"]').text()).toContain('Añadir (1)')
    await w.get('[data-test="browser-add"]').trigger('click')
    await settle()
    expect(rowNames(w)[4]).toContain('Restaurar paquete de «Copia nocturna Staging» en Local')
    expect(w.get('[data-test="job-task-4"] [data-test="step-detail"]').text()).toBe(
      '2 bases elegidas · con copia previa'
    )
    const input = await saved(w)
    expect(input.tasks[3]).toMatchObject({
      type: 'restorepackage',
      connectionId: 'l1',
      packageSource: { kind: 'own' }
    })
    expect(input.tasks[3].packageDatabases).toBeUndefined()
    expect(input.tasks[4]).toMatchObject({
      type: 'restorepackage',
      packageSource: { kind: 'job', jobId: 'job-2', jobName: 'Copia nocturna Staging' },
      packageDatabases: ['auth', 'ventas']
    })
  })

  it('package step settings: todas / solo las marcadas, names per database, safety copy', async () => {
    current = makeJob({
      ...current,
      tasks: [
        ...steps().slice(0, 2),
        {
          id: 'p1',
          type: 'restorepackage',
          connectionId: 'l1',
          schema: '',
          referenceName: '',
          packageSource: { kind: 'own' },
          safetyBackup: true,
          includeData: true
        }
      ]
    })
    const w = await mountEditor()
    await w.get('[data-test="job-task-2"]').trigger('click')
    await settle()
    const panel = () => w.get('[data-test="step-settings"]')
    expect(panel().text()).toContain('2 copias de los pasos anteriores de esta tarea')
    expect(panel().find('[data-test="package-db-shop"]').exists()).toBe(true)
    await panel().get('[data-test="package-whole-some"]').trigger('click')
    await settle()
    await panel().get('[data-test="package-db-crm"] input[type="checkbox"]').setValue(false)
    await panel().get('[data-test="package-target-shop"] input').setValue('shop_dev')
    await panel().get('[data-test="package-safety-off"]').trigger('click')
    await settle()
    expect(w.get('[data-test="job-task-2"] [data-test="step-detail"]').text()).toBe(
      '1 base elegida · sin copia previa'
    )
    const input = await saved(w)
    expect(input.tasks[2]).toMatchObject({
      packageDatabases: ['shop'],
      packageTargets: { shop: 'shop_dev' },
      safetyBackup: false
    })
    // A production target is refused like any restore.
    await w.get('[data-test="job-task-2"]').trigger('click')
    await settle()
    const target = w
      .findAllComponents({ name: 'VSelect' })
      .find((c) => c.attributes('data-test') === 'package-target')!
    target.vm.$emit('update:modelValue', 'p1')
    await settle()
    expect(w.get('[data-test="job-task-2"] [data-test="step-problem"]').text()).toContain(
      'producción'
    )
  })

  it('a default step name follows its target; a name the user typed stays', async () => {
    current = makeJob({
      ...current,
      tasks: [
        steps()[0],
        {
          id: 'r1',
          type: 'restoreschema',
          connectionId: 'l1',
          schema: '',
          referenceName: 'Restaurar shop en Local',
          restoreSource: { kind: 'task', taskId: 'b1' },
          safetyBackup: true,
          includeData: true
        }
      ]
    })
    const w = await mountEditor()
    await w.get('[data-test="job-task-1"]').trigger('click')
    await settle()
    await w.get('[data-test="restore-target-schema"] input').setValue('shop_dev')
    await settle()
    expect(rowNames(w)[1]).toContain('Restaurar shop_dev en Local')
    await w.get('[data-test="step-reference"] input').setValue('Mi restauración')
    await w.get('[data-test="restore-target-schema"] input').setValue('shop_qa')
    await settle()
    expect(rowNames(w)[1]).toContain('Mi restauración')
  })

  it('shows «Sin programar», then the schedule from the Programación section', async () => {
    const w = await mountEditor()
    const pill = w.get('[data-test="job-schedule-pill"]')
    expect(pill.text()).toContain('Sin programar')
    await pill.trigger('click')
    await settle()
    expect(w.get('[data-test="job-section-schedule"]').attributes('aria-selected')).toBe('true')
    await w.get('[data-test="job-schedule-enabled"] input').setValue(true)
    await settle()
    expect(w.get('[data-test="job-schedule-pill"]').text()).not.toContain('Sin programar')
    const input = await saved(w)
    expect(input.schedule).toMatchObject({ enabled: true, cron: '0 3 * * *' })
  })

  it('moves between sections with the arrow keys and keeps «Continuar en caso de error» in Opciones', async () => {
    const w = await mountEditor()
    await w.get('[data-test="job-section-steps"]').trigger('keydown', { key: 'ArrowRight' })
    await settle()
    expect(w.get('[data-test="job-section-schedule"]').attributes('aria-selected')).toBe('true')
    await w.get('[data-test="job-section-schedule"]').trigger('keydown', { key: 'ArrowRight' })
    await settle()
    await w.get('[data-test="job-continue-on-error"] input').setValue(false)
    const input = await saved(w)
    expect(input.continueOnError).toBe(false)
  })

  it('Intro opens the settings with the focus inside, Esc returns it to the row, Backspace removes nothing', async () => {
    const w = await mountEditor()
    const row = w.get('[data-test="job-task-1"]')
    await row.trigger('keydown', { key: 'Backspace' })
    await row.trigger('keydown', { key: 'Enter' })
    await settle()
    expect(rowNames(w)).toHaveLength(3)
    expect(document.activeElement?.textContent).toBe('Paso 2')
    await w.get('[data-test="step-settings"]').trigger('keydown', { key: 'Escape' })
    await settle()
    expect(w.find('[data-test="step-settings"]').exists()).toBe(false)
    expect(document.activeElement?.getAttribute('data-test')).toBe('job-task-1')
  })

  it('keeps the browser selection when visiting another section', async () => {
    const w = await mountEditor()
    await w.get('[data-test="step-kind-savedQuery"]').trigger('click')
    await w.get('[data-test="browse-connection-c1"]').trigger('click')
    await settle()
    await w.get('[data-test="job-section-options"]').trigger('click')
    await w.get('[data-test="job-section-steps"]').trigger('click')
    await settle()
    expect(w.get('[data-test="step-browser-items"]').text()).toContain('Cerrar pedidos')
  })

  it('the history section explains that a new job has none yet', async () => {
    const w = await mountEditor(null)
    await w.get('[data-test="job-section-history"]').trigger('click')
    await settle()
    expect(w.text()).toContain('Sin historial todavía')
  })
})
