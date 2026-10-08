import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  ImportConnectionItem,
  ImportSourceInfo,
  SqlDumpImportResult,
  SqlDumpInspection
} from '@shared/importers'
import type { ProgressEvent } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import {
  calls,
  freshPinia,
  makeConnection,
  mountWith,
  settle
} from '@renderer/components/dialogs/testing'
import ImportWizard from './ImportWizard.vue'

type Handler = (...args: unknown[]) => unknown

const source = (
  id: ImportSourceInfo['id'],
  flow: ImportSourceInfo['flow'],
  extra: Partial<ImportSourceInfo> = {}
): ImportSourceInfo => ({
  id,
  flow,
  label: id,
  description: `desc ${id}`,
  icon: 'mdi-import',
  pick: flow === 'sqlFolder' || flow === 'navicatFolder' ? 'folder' : 'file',
  filters: [],
  defaultPathHint: null,
  detectedPath: null,
  mayContainPasswords: id === 'navicat-ncx',
  ...extra
})

const SOURCES: ImportSourceInfo[] = [
  source('navicat-folder', 'navicatFolder'),
  source('navicat-ncx', 'connections'),
  source('dbeaver', 'connections', { detectedPath: '/home/u/data-sources.json' }),
  source('workbench', 'connections'),
  source('sql-dump', 'sqlDump'),
  source('sql-folder', 'sqlFolder'),
  source('nb3', 'nb3')
]

const item = (key: string, extra: Partial<ImportConnectionItem> = {}): ImportConnectionItem => ({
  key,
  name: key,
  engine: 'mysql',
  engineLabel: 'MySQL',
  host: 'db.example.test',
  port: 3306,
  username: 'app_user',
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

const inspection = (extra: Partial<SqlDumpInspection> = {}): SqlDumpInspection => ({
  path: '/dumps/shop.sql',
  fileName: 'shop.sql',
  sizeBytes: 4096,
  gzip: false,
  tool: 'mysqldump',
  databases: ['shop'],
  hasCreateDatabase: true,
  hasUse: true,
  counts: { databases: 1, tables: 3, views: 1, routines: 2, triggers: 1, events: 0, inserts: 9 },
  usesDelimiter: true,
  hasDefiners: true,
  warnings: [],
  ...extra
})

const dumpResult = (extra: Partial<SqlDumpImportResult> = {}): SqlDumpImportResult => ({
  statements: 40,
  executed: 39,
  rowsAffected: 120,
  created: { databases: 0, tables: 3, views: 1, routines: 2, triggers: 1, events: 0, inserts: 0 },
  errors: [{ line: 57, statement: 'INSERT INTO `x` VALUES (1)', message: 'Duplicate entry' }],
  skipped: 1,
  databases: ['shop_copy'],
  bytesRead: 4096,
  bytesTotal: 4096,
  durationMs: 1500,
  safetyBackupPath: null,
  ...extra
})

/** window.vortaq with handlers and a working event bus. */
function bridge(handlers: Record<string, Handler>): {
  invoke: Mock
  emit: (event: ProgressEvent) => void
} {
  const listeners: ((p: unknown) => void)[] = []
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel]
    return handler ? handler(...args) : undefined
  })
  window.vortaq = {
    invoke,
    on: vi.fn((_channel: string, listener: (p: unknown) => void) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    })
  } as never
  return { invoke, emit: (event) => listeners.forEach((l) => l(event)) }
}

const q = (sel: string): HTMLElement | null => document.querySelector(sel)
const click = async (sel: string): Promise<void> => {
  const el = q(sel)
  if (!el) throw new Error(`missing ${sel}`)
  el.click()
  await settle()
}

describe('ImportWizard', () => {
  let wrapper: ReturnType<typeof mountWith> | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  async function open(handlers: Record<string, Handler>) {
    const b = bridge({
      'importers:sources': () => SOURCES,
      'connections:list': () => [],
      ...handlers
    })
    const pinia = freshPinia()
    await useConnectionsStore().load()
    useUiStore().openImportWizard()
    wrapper = mountWith(ImportWizard, pinia)
    await settle()
    return b
  }

  describe('source list', () => {
    it('groups every source and marks a file found at its usual place', async () => {
      await open({})
      for (const s of SOURCES) expect(q(`[data-test="import-source-${s.id}"]`)).not.toBeNull()
      expect(q('[data-test="import-source-dbeaver"]')!.textContent).toContain('encontrado')
      expect(q('[data-test="import-source-workbench"]')!.textContent).not.toContain('encontrado')
    })

    it('the Navicat folder hands over to its own dialog, with a way back', async () => {
      await open({})
      await click('[data-test="import-source-navicat-folder"]')
      const ui = useUiStore()
      expect(ui.importWizard).toBe(false)
      expect(ui.importDialog).toBe(true)
      expect(ui.importDialogRequest).toEqual({ fromWizard: true })
    })

    it('a .nb3 copy opens the restore dialog with the picked file', async () => {
      await open({ 'importers:pick': () => '/copias/20260101120000.nb3' })
      await click('[data-test="import-source-nb3"]')
      const ui = useUiStore()
      expect(ui.importWizard).toBe(false)
      expect(ui.restoreDialog.open).toBe(true)
      expect(ui.restoreDialog.backup?.path).toBe('/copias/20260101120000.nb3')
      expect(ui.restoreDialog.backup?.fileName).toBe('20260101120000.nb3')
    })
  })

  describe('connections file', () => {
    beforeEach(() => undefined)

    it('DBeaver: uses the detected file, preselects new rows, imports and says passwords are typed', async () => {
      const { invoke } = await open({
        'importers:previewConnections': (_s, path) => ({
          source: 'dbeaver',
          path,
          items: [
            item('local'),
            item('old', { existingConnectionId: 'c9' }),
            item('pg', {
              engine: null,
              engineLabel: 'PostgreSQL',
              unsupportedReason: 'Motor no soportado en esta versión: PostgreSQL'
            })
          ],
          notes: ['Las contraseñas no se importan: DBeaver las guarda cifradas.'],
          containsPasswords: false
        }),
        'importers:importConnections': () => ({
          created: [makeConnection({ id: 'n1', name: 'local' })],
          updated: [],
          passwordsSaved: 0,
          warnings: []
        })
      })
      await click('[data-test="import-source-dbeaver"]')
      expect(q('[data-test="import-file-detected"]')!.textContent).toContain(
        '/home/u/data-sources.json'
      )
      await click('[data-test="import-file-use"]')
      expect(calls(invoke, 'importers:previewConnections')).toEqual([
        ['dbeaver', '/home/u/data-sources.json']
      ])
      expect(document.querySelectorAll('[data-test="import-connection-row"]')).toHaveLength(3)
      expect(q('[data-test="import-note"]')!.textContent).toContain('DBeaver las guarda cifradas')
      const run = q('[data-test="import-connections-run"]')!
      expect(run.textContent).toContain('Importar (1)')
      await click('[data-test="import-connections-run"]')
      expect(calls(invoke, 'importers:importConnections')).toEqual([
        [
          {
            source: 'dbeaver',
            path: '/home/u/data-sources.json',
            keys: ['local'],
            existingMode: 'replace'
          }
        ]
      ])
      expect(q('[data-test="import-connections-result"]')!.textContent).toContain(
        '1 conexión nueva'
      )
      expect(q('[data-test="import-type-passwords"]')).not.toBeNull()
      expect(q('[data-test="import-delete-file"]')).toBeNull()
    })

    it('.ncx with passwords: «Actualizar solo la contraseña» for imported rows and a reminder to delete the file', async () => {
      const { invoke } = await open({
        'importers:pick': () => '/Users/u/Desktop/conexiones.ncx',
        'importers:previewConnections': (_s, path) => ({
          source: 'navicat-ncx',
          path,
          items: [
            item('MySQL:prod', { existingConnectionId: 'c1', hasPassword: true }),
            item('MySQL:new', { hasPassword: true })
          ],
          notes: [],
          containsPasswords: true
        }),
        'importers:importConnections': () => ({
          created: [],
          updated: [makeConnection({ id: 'c1', name: 'prod' })],
          passwordsSaved: 1,
          warnings: []
        })
      })
      await click('[data-test="import-source-navicat-ncx"]')
      expect(q('[data-test="import-ncx-passwords"]')).not.toBeNull()
      await click('[data-test="import-file-pick"]')
      expect(document.querySelectorAll('[data-test="import-has-password"]')).toHaveLength(2)
      // Tick the already imported row too.
      const boxes = document.querySelectorAll<HTMLInputElement>(
        '[data-test="import-connection-row"] input[type="checkbox"]'
      )
      boxes[0].click()
      await settle()
      expect(q('[data-test="import-existing-mode"]')).not.toBeNull()
      await click('[data-test="import-connections-run"]')
      const [request] = calls(invoke, 'importers:importConnections')[0] as [
        { keys: string[]; existingMode: string }
      ]
      expect(request.existingMode).toBe('passwords')
      expect(request.keys.sort()).toEqual(['MySQL:new', 'MySQL:prod'])
      expect(q('[data-test="import-delete-file"]')!.textContent).toContain(
        'Borra el .ncx: contiene contraseñas'
      )
    })

    it('shows the error of a file that cannot be read and stays on the file step', async () => {
      await open({
        'importers:pick': () => '/x/roto.ncx',
        'importers:previewConnections': () => {
          throw new Error('El archivo no es un .ncx válido')
        }
      })
      await click('[data-test="import-source-navicat-ncx"]')
      await click('[data-test="import-file-pick"]')
      expect(q('[data-test="import-error"]')!.textContent).toContain('no es un .ncx válido')
      expect(q('[data-test="import-file-pick"]')).not.toBeNull()
    })
  })

  describe('SQL dump', () => {
    const local = makeConnection({ id: 'loc', name: 'Local', environment: 'local' })
    const prod = makeConnection({ id: 'prd', name: 'Prod', environment: 'production' })

    async function openDump(extra: Record<string, Handler> = {}) {
      return open({
        'connections:list': () => [prod, local],
        'connections:isOpen': () => true,
        'db:databases': () => [{ name: 'shop' }, { name: 'other' }],
        'importers:pick': () => '/dumps/shop.sql',
        'importers:inspectSqlDump': () => inspection(),
        ...extra
      })
    }

    it('proposes the local connection and «importar todo en <esquema>» named after the dump', async () => {
      await openDump()
      await click('[data-test="import-source-sql-dump"]')
      await click('[data-test="import-file-pick"]')
      expect(q('[data-test="dump-inspection"]')!.textContent).toContain('mysqldump')
      expect(q('[data-test="dump-inspection"]')!.textContent).toContain('3 tablas')
      const schema = q('[data-test="dump-schema"] input') as HTMLInputElement
      expect(schema.value).toBe('shop')
      const radio = q('[data-test="dump-mode-schema"] input') as HTMLInputElement
      expect(radio.checked).toBe(true)
    })

    it('several databases: respects the file by default and warns when everything goes to one schema', async () => {
      await openDump({
        'importers:inspectSqlDump': () => inspection({ databases: ['a', 'b'] })
      })
      await click('[data-test="import-source-sql-dump"]')
      await click('[data-test="import-file-pick"]')
      expect((q('[data-test="dump-mode-file"] input') as HTMLInputElement).checked).toBe(true)
      expect(q('[data-test="dump-several-databases"]')).toBeNull()
      ;(q('[data-test="dump-mode-schema"] input') as HTMLInputElement).click()
      await settle()
      expect(q('[data-test="dump-several-databases"]')!.textContent).toContain('2 bases de datos')
    })

    it('runs with a live log, then lists errors with their line', async () => {
      let finish: (r: SqlDumpImportResult) => void = () => undefined
      const { invoke, emit } = await openDump({
        'importers:importSqlDump': () => new Promise((resolve) => (finish = resolve))
      })
      await click('[data-test="import-source-sql-dump"]')
      await click('[data-test="import-file-pick"]')
      await click('[data-test="dump-run"]')
      const [opId, options] = calls(invoke, 'importers:importSqlDump')[0] as [string, object]
      expect(options).toMatchObject({
        path: '/dumps/shop.sql',
        connectionId: 'loc',
        mode: 'intoSchema',
        targetSchema: 'shop',
        createSchema: true,
        replaceSchema: false,
        continueOnError: false
      })
      expect(options).not.toHaveProperty('confirmProduction')
      const base = { operationId: opId, kind: 'import' as const, done: false, total: 4096 }
      emit({ ...base, phase: 'statement', current: 2048, message: 'Línea 30 · 12 sentencias' })
      emit({
        ...base,
        phase: 'object',
        current: 2048,
        message: 'Tabla clientes creada',
        detail: { objectType: 'Table', objectName: 'clientes' }
      })
      emit({
        ...base,
        phase: 'objectError',
        current: 3000,
        message: 'Error en la línea 57',
        detail: { error: 'Duplicate entry', objectName: 'INSERT INTO `x`' }
      })
      await settle()
      expect(q('[data-test="dump-progress"]')!.textContent).toContain('73%')
      expect(q('[data-test="dump-progress"]')!.textContent).toContain('Línea 30')
      const log = q('[data-test="import-log"]')!.textContent!
      expect(log).toContain('Tabla clientes creada')
      expect(log).toContain('Error en la línea 57: Duplicate entry')
      finish(dumpResult())
      await settle()
      expect(q('[data-test="dump-result"]')!.textContent).toContain('39 de 40 sentencias')
      expect(q('[data-test="dump-errors"]')!.textContent).toContain('Línea 57')
    })

    it('a production target needs its name typed and sends the confirmation', async () => {
      const { invoke } = await openDump({
        'importers:importSqlDump': () => dumpResult({ errors: [] })
      })
      await click('[data-test="import-source-sql-dump"]')
      await click('[data-test="import-file-pick"]')
      // Pick «Prod» through the component state (the v-select menu is not rendered in jsdom).
      const vm = wrapper!.findComponent({ name: 'ImportTarget' })
      vm.vm.$emit('update:connectionId', 'prd')
      await settle()
      expect(q('[data-test="import-typed-confirm"]')).not.toBeNull()
      expect((q('[data-test="dump-run"]') as HTMLButtonElement).disabled).toBe(true)
      const typed = q('[data-test="import-typed-name"] input') as HTMLInputElement
      typed.value = 'Prod'
      typed.dispatchEvent(new Event('input'))
      await settle()
      expect((q('[data-test="dump-run"]') as HTMLButtonElement).disabled).toBe(false)
      await click('[data-test="dump-run"]')
      expect(calls(invoke, 'importers:importSqlDump')[0][1]).toMatchObject({
        connectionId: 'prd',
        confirmProduction: true
      })
    })

    it('settings can require the typed name for staging too', async () => {
      await openDump({
        'connections:list': () => [
          makeConnection({ id: 'stg', name: 'Pre', environment: 'staging' })
        ]
      })
      useSettingsStore().settings.typedConfirmEnvironments = ['staging']
      await click('[data-test="import-source-sql-dump"]')
      await click('[data-test="import-file-pick"]')
      wrapper!.findComponent({ name: 'ImportTarget' }).vm.$emit('update:connectionId', 'stg')
      await settle()
      expect(q('[data-test="import-typed-confirm"]')).not.toBeNull()
    })
  })

  describe('folder of dumps', () => {
    it('maps file names to databases, refuses duplicates and imports the package into Local', async () => {
      const { invoke } = await open({
        'connections:list': () => [makeConnection({ id: 'loc', name: 'Local' })],
        'connections:isOpen': () => true,
        'db:databases': () => [{ name: 'ventas' }],
        'importers:pick': () => '/dumps',
        'importers:previewSqlFolder': () => ({
          dir: '/dumps',
          items: [
            { path: '/dumps/ventas.sql', fileName: 'ventas.sql', sizeBytes: 10, schema: 'ventas' },
            { path: '/dumps/crm.sql.gz', fileName: 'crm.sql.gz', sizeBytes: 20, schema: 'crm' }
          ],
          warnings: ['Se ignora notas.txt: no es .sql ni .sql.gz']
        }),
        'importers:importSqlFolder': () => ({ items: [], durationMs: 5 })
      })
      await click('[data-test="import-source-sql-folder"]')
      await click('[data-test="import-folder-pick"]')
      expect(document.querySelectorAll('[data-test="folder-row"]')).toHaveLength(2)
      expect(q('[data-test="folder-rows"]')!.textContent).toContain('existe')
      const inputs = document.querySelectorAll<HTMLInputElement>(
        '[data-test="folder-schema"] input'
      )
      inputs[1].value = 'ventas'
      inputs[1].dispatchEvent(new Event('input'))
      await settle()
      expect(q('[data-test="folder-rows"]')!.textContent).toContain('Nombre repetido')
      expect((q('[data-test="folder-run"]') as HTMLButtonElement).disabled).toBe(true)
      inputs[1].value = 'crm_local'
      inputs[1].dispatchEvent(new Event('input'))
      await settle()
      await click('[data-test="folder-run"]')
      // «ventas» exists: replacing it asks first.
      expect(useUiStore().confirm.open).toBe(true)
      useUiStore().answer(true)
      await settle()
      expect(calls(invoke, 'importers:importSqlFolder')[0][1]).toEqual({
        dir: '/dumps',
        connectionId: 'loc',
        items: [
          { path: '/dumps/ventas.sql', schema: 'ventas' },
          { path: '/dumps/crm.sql.gz', schema: 'crm_local' }
        ],
        replaceSchema: true,
        safetyBackup: true,
        continueOnError: false
      })
    })
  })
})
