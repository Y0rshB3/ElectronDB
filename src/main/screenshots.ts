import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { envVar } from './env'

/**
 * Screenshot harness (development only).
 *
 * ELECTRONDB_SCREENSHOTS=<dir> together with ELECTRONDB_USER_DATA=<scratch profile>
 * opens a 1600x1000 window whose renderer installs a debug hook
 * (`window.__electronDBShots`, see renderer main.ts, enabled by the
 * `nd-screenshots=1` query parameter), drives the UI through the stores and
 * saves one PNG per screen. Each step is isolated: a failure is logged and the
 * run continues. Never enabled in normal runs.
 */

export const SCREENSHOT_WINDOW = { width: 1600, height: 1000 }
export const SCREENSHOT_QUERY = { 'nd-screenshots': '1' }

/** Resolved screenshot directory, or null when the harness is off. */
export function screenshotDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = envVar('SCREENSHOTS', env)?.trim()
  if (!dir) return null
  return isAbsolute(dir) ? dir : resolve(dir)
}

interface Step {
  name: string
  /** Body of an async function run in the renderer with `S` (hook) and `H` (helpers) in scope. */
  script: string
  /** Extra settle time before capturing. */
  settleMs?: number
  /** Body run after the capture (closing dialogs...). */
  cleanup?: string
  /** Window content size for this step (narrow layouts); restored afterwards. */
  size?: { width: number; height: number }
}

const LOCAL = 'Local Test'
/** Database of the throwaway test MySQL (its name predates the ElectronDB rename). */
const SCHEMA = 'navidog_test'
/** Scratch schema created and dropped by the live job log steps. */
const BIG_SCHEMA = 'electrondb_shots_big'
const LIVE_JOB = 'Backup con errores'

/** Helpers installed once in the renderer. */
const HELPERS = `
window.__ndShotHelpers = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function until(fn, timeout = 10000, every = 100) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v } catch (e) { /* retry */ }
      await sleep(every)
    }
    throw new Error('timeout waiting for condition: ' + fn.toString().slice(0, 120))
  }
  const visible = (el) => !!el && el.getClientRects().length > 0
  const $ = (sel) => [...document.querySelectorAll(sel)].find(visible) || null
  const waitFor = (sel, timeout) => until(() => $(sel), timeout)
  async function click(sel, timeout) { const el = await waitFor(sel, timeout); el.click(); return el }
  function idle(S) {
    return Object.keys(S.tree.loading).length === 0 && Object.keys(S.connections.opening).length === 0
  }
  async function settle(S, ms = 600) {
    await until(() => idle(S), 15000)
    await sleep(ms)
  }
  function local(S) {
    const c = S.connections.items.find((x) => x.name === ${JSON.stringify(LOCAL)})
    if (!c) throw new Error('connection "${LOCAL}" not found (run scripts/seed-screenshots.mjs)')
    return c
  }
  return { sleep, until, $, waitFor, click, idle, settle, local }
})()
true
`

/** Opens `sql` in a new query tab, runs it and waits for the first result's editability chip. */
const RUN_QUERY = (sql: string, name: string, chip: string): string => `
      const c = H.local(S)
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql: ${JSON.stringify(sql)}, name: ${JSON.stringify(name)} })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => ${JSON.stringify(chip)} === '' || new RegExp(${JSON.stringify(chip)}).test(H.$('[data-test="editability"]')?.textContent || ''), 15000)`

/** Pending edits on an editable shot_customers result: one cell, one NULL, one deleted row, one new row. */
const EDIT_RESULT = `
      async function typeInto(sel, value) {
        const cell = await H.waitFor(sel, 5000)
        cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const input = await H.waitFor('[data-test="cell-input"]', 5000)
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await H.sleep(150)
      }
      await typeInto('[data-test="cell-0-1"]', 'Cliente editado')
      await H.click('[data-test="cell-1-4"]', 5000)
      await H.click('[data-test="set-null"]', 5000)
      await H.click('[data-test="row-2"] td', 5000)
      await H.click('[data-test="delete-rows"]', 5000)
      await H.click('[data-test="add-row"]', 5000)
      await H.sleep(200)`

const STEPS: Step[] = [
  {
    name: '01-home',
    script: `
      S.ui.toggleInfoPanel(true)
      S.workspace.showObjects()
      S.tree.select(null)
      await H.settle(S, 900)`
  },
  {
    name: '02-tree-expanded',
    script: `
      const c = H.local(S)
      await S.tree.expand(S.tree.parse('c:' + c.id))
      if (!S.connections.isOpen(c.id)) throw new Error('could not open ${LOCAL}')
      const schemaId = 's:' + c.id + ':${SCHEMA}'
      S.tree.setExpanded(schemaId, true)
      await S.tree.expand(S.tree.parse('g:' + c.id + ':${SCHEMA}:tables'))
      await S.tree.expand(S.tree.parse('g:' + c.id + ':${SCHEMA}:views'))
      S.tree.select(schemaId)
      S.workspace.showObjects()
      await H.settle(S, 900)`
  },
  {
    name: '03-objects-tables',
    script: `
      S.ui.objectsViewMode = 'list'
      const ok = await S.workspace.showGroup('tables')
      if (!ok) throw new Error('showGroup(tables) failed')
      await H.settle(S, 1200)`
  },
  {
    name: '04-table-data',
    script: `
      const c = H.local(S)
      S.workspace.openTableData(c.id, '${SCHEMA}', 'shot_customers')
      await H.waitFor('.v-window-item--active table tbody tr, table tbody tr', 15000).catch(() => null)
      await H.settle(S, 1800)`
  },
  {
    name: '05-query',
    script: `
      const c = H.local(S)
      const sql = [
        '-- Clientes con más pedidos',
        'SELECT c.id, c.name, c.country, COUNT(o.id) AS pedidos, ROUND(SUM(o.total), 2) AS facturado',
        'FROM shot_customers c',
        'JOIN shot_orders o ON o.customer_id = c.id',
        'GROUP BY c.id, c.name, c.country',
        'ORDER BY facturado DESC',
        'LIMIT 50;'
      ].join('\\n')
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql, name: 'Top clientes' })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => !H.$('[data-test="stop"]:not([disabled])'), 15000).catch(() => null)
      await H.settle(S, 1800)`
  },
  {
    name: '05b-query-editable',
    script: `
      // One base table with its primary key: the result is editable (Navicat behaviour).
      const c = H.local(S)
      S.workspace.openQuery(c.id, '${SCHEMA}', {
        sql: 'SELECT * FROM shot_customers AS c WHERE c.id < 5',
        name: 'Clientes editables'
      })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => /Editable/.test(H.$('[data-test="editability"]')?.textContent || ''), 15000)
      const cell = await H.waitFor('[data-test="cell-1-1"]', 5000)
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const input = await H.waitFor('[data-test="cell-input"]', 5000)
      input.value = 'Cliente editado'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await H.click('[data-test="cell-2-4"]', 5000)
      await H.settle(S, 1200)`
  },
  {
    name: '05c-query-join-readonly',
    script: `
      const c = H.local(S)
      const sql = [
        'SELECT c.id, c.name, o.id AS pedido, o.status, o.total',
        'FROM shot_customers c',
        'JOIN shot_orders o ON o.customer_id = c.id',
        'LIMIT 30'
      ].join('\\n')
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql, name: 'Pedidos por cliente' })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => /Solo lectura/.test(H.$('[data-test="editability"]')?.textContent || ''), 15000)
      await H.settle(S, 1200)`
  },
  {
    name: '05d-query-edit-1280',
    size: { width: 1280, height: 800 },
    script:
      RUN_QUERY('SELECT * FROM shot_customers AS c WHERE c.id < 6', 'Edición 1280', 'Editable') +
      EDIT_RESULT +
      `
      await H.settle(S, 900)`
  },
  {
    name: '05e-query-edit-1100',
    size: { width: 1100, height: 760 },
    script:
      RUN_QUERY('SELECT * FROM shot_customers AS c WHERE c.id < 6', 'Edición 1100', 'Editable') +
      EDIT_RESULT +
      `
      await H.settle(S, 900)`
  },
  {
    name: '05f-query-apply-error',
    script:
      RUN_QUERY(
        'SELECT * FROM shot_customers AS c WHERE c.id < 6',
        'Error al aplicar',
        'Editable'
      ) +
      EDIT_RESULT +
      `
      // city is NOT NULL: the whole batch fails and is rolled back (nothing is written).
      await H.click('[data-test="apply"]', 5000)
      await H.sleep(400)
      if (S.ui.confirm.open) S.ui.answer(true)
      await H.waitFor('[data-test="apply-error"]', 10000)
      await H.settle(S, 900)`
  },
  {
    name: '05g-query-many-results-1100',
    size: { width: 1100, height: 760 },
    script:
      RUN_QUERY(
        Array.from(
          { length: 8 },
          (_, i) => `SELECT id, name, city FROM shot_customers WHERE id > ${i * 3} LIMIT ${i + 2};`
        ).join('\n'),
        'Varios resultados',
        'Editable'
      ) +
      `
      await H.click('[data-test="tab-rs2"]', 5000)
      await H.settle(S, 900)`
  },
  {
    name: '05h-query-results-menu',
    size: { width: 1100, height: 760 },
    script: `
      await H.click('[data-test="results-menu"]', 5000)
      await H.waitFor('.v-overlay--active .v-list', 5000)
      await H.sleep(400)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    name: '05i-query-view-readonly',
    script:
      RUN_QUERY('SELECT * FROM shot_customer_totals', 'Vista', 'Solo lectura') +
      `
      await H.settle(S, 900)`
  },
  {
    name: '05j-table-data-1100',
    size: { width: 1100, height: 760 },
    script: `
      const c = H.local(S)
      S.workspace.openTableData(c.id, '${SCHEMA}', 'shot_orders')
      await H.waitFor('[data-test="cell-0-1"]', 15000)
      await H.click('[data-test="cell-1-2"]', 5000)
      await H.click('[data-test="set-null"]', 5000)
      await H.settle(S, 900)`
  },
  {
    name: '06-designer',
    script: `
      const c = H.local(S)
      S.workspace.openTableDesigner(c.id, '${SCHEMA}', 'shot_orders')
      await H.settle(S, 2000)`
  },
  {
    name: '07-backups',
    script: `
      const c = H.local(S)
      S.workspace.openBackups(c.id, null)
      const row = await H.waitFor('[data-test="backup-row"]', 10000)
      row.click()
      await H.settle(S, 1500)`
  },
  {
    name: '08-automation',
    script: `
      S.workspace.openAutomation()
      const row = await H.waitFor('[data-test="automation-view"] tbody tr', 10000)
      row.click()
      await H.settle(S, 1500)`
  },
  {
    name: '09-job-editor',
    script: `
      await S.jobs.load()
      const job = S.jobs.sorted[0]
      if (!job) throw new Error('no jobs (run scripts/seed-screenshots.mjs)')
      S.workspace.openJobEditor(job.id, job.name)
      await H.settle(S, 1500)`
  },
  {
    name: '10-connection-dialog',
    script: `
      S.ui.openConnectionDialog(H.local(S))
      await H.waitFor('.v-dialog .v-card', 5000)
      await H.settle(S, 900)`,
    cleanup: `S.ui.connectionDialog = { open: false, editing: null }`
  },
  {
    name: '11-import-dialog',
    script: `
      S.ui.openImportDialog()
      await H.waitFor('[data-test="import-dialog"]', 5000)
      await H.settle(S, 1500)`,
    cleanup: `S.ui.importDialog = false`
  },
  {
    name: '12-restore-dialog',
    script: `
      const c = H.local(S)
      const backups = await S.api.backups.list(c.id, null)
      if (!backups.length) throw new Error('no backups listed for ${LOCAL}')
      S.ui.openRestoreDialog(backups[0], c.id)
      await H.waitFor('[data-test="restore-dialog"]', 5000)
      await H.settle(S, 1500)`,
    cleanup: `S.ui.restoreDialog = { open: false, backup: null, connectionId: null }`
  },
  {
    name: '13-settings-dialog',
    script: `
      S.ui.openSettingsDialog()
      await H.waitFor('.v-dialog .v-card', 5000)
      await H.settle(S, 900)`,
    cleanup: `S.ui.settingsDialog = false`
  },
  {
    name: '14-production-confirm',
    script: `
      const prod = S.connections.items.find((x) => x.environment === 'production')
      void S.ui.ask({
        title: 'Eliminar filas',
        message: 'Se eliminarán 12 filas de shot_orders.\\n\\nEsta conexión está marcada como PRODUCCIÓN. Escribe el nombre de la conexión para continuar.',
        details: 'DELETE FROM shot_orders WHERE status = \\'cancelled\\' AND created_at < \\'2026-01-01\\';',
        confirmText: 'Ejecutar en producción',
        color: 'error',
        requireTyped: prod ? prod.name : 'Production Demo',
        production: true
      })
      await H.waitFor('.v-dialog .v-card', 5000)
      await H.sleep(900)`,
    cleanup: `S.ui.answer(false)`
  },
  {
    // Live automation log (Navicat batch job log): a job backing up the test schema, a
    // larger scratch schema (so the capture lands mid-run) and a missing schema that fails.
    name: '15a-job-live-log',
    script: `
      const c = H.local(S)
      const big = ${JSON.stringify(BIG_SCHEMA)}
      const sql = [
        'DROP DATABASE IF EXISTS ' + big,
        'CREATE DATABASE ' + big,
        'CREATE TABLE ' + big + '.accounts (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)',
        "INSERT INTO " + big + ".accounts VALUES (1, 'demo'), (2, 'test')",
        'CREATE TABLE ' + big + '.seq (n INT PRIMARY KEY)',
        'INSERT INTO ' + big + '.seq WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 999) SELECT n FROM s',
        'CREATE TABLE ' + big + '.events (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(12) NOT NULL, payload VARCHAR(160) NOT NULL, created_at DATETIME NOT NULL)',
        "INSERT INTO " + big + ".events (kind, payload, created_at) SELECT ELT(1 + (b.n % 4), 'login', 'logout', 'view', 'click'), REPEAT(MD5(a.n * 1000 + b.n), 4), NOW() - INTERVAL (a.n * 1000 + b.n) SECOND FROM " + big + ".seq a CROSS JOIN " + big + ".seq b WHERE a.n < 400",
        'CREATE VIEW ' + big + '.v_logins AS SELECT id, created_at FROM ' + big + ".events WHERE kind = 'login'"
      ]
      for (const statement of sql) await S.api.invokeSilent('db:execute', c.id, statement, {})
      const job = await S.jobs.save({
        name: ${JSON.stringify(LIVE_JOB)},
        continueOnError: true,
        tasks: [
          { id: 'l1', type: 'backupschema', connectionId: c.id, schema: '${SCHEMA}', referenceName: 'Backup ${SCHEMA}', includeData: true },
          { id: 'l2', type: 'backupschema', connectionId: c.id, schema: big, referenceName: 'Backup ' + big, includeData: true },
          { id: 'l3', type: 'backupschema', connectionId: c.id, schema: 'electrondb_missing', referenceName: 'Backup electrondb_missing', includeData: true },
          { id: 'l4', type: 'runquery', connectionId: c.id, schema: '${SCHEMA}', referenceName: 'Comprobar pedidos', sql: 'DO 1;' }
        ],
        schedule: { enabled: false, cron: '', launchAgent: false }
      })
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.openAutomation()
      const rows = await H.until(() => {
        const list = [...document.querySelectorAll('[data-test="automation-view"] tbody tr')]
        return list.find((r) => r.textContent.includes(job.name))
      }, 10000)
      rows.click()
      await H.sleep(300)
      await H.click('[data-test="jobs-run"]', 5000)
      // Mid-run: the small tables of the second step are logged, its big table is still running.
      await H.until(() => /Tabla accounts/.test(H.$('[data-test="run-log-panel"]')?.textContent || ''), 60000, 50)
      // The card counts rows against the table's estimate and its bar moves inside the table.
      try {
        await H.until(() => /Tabla events .*de ~/.test(H.$('[data-test="progress-message"]')?.textContent || ''), 30000, 50)
      } catch (e) { /* small server: the table may finish first */ }
      await H.sleep(250)`
  },
  {
    name: '15b-job-log-summary',
    script: `
      await H.until(() => H.$('[data-test="run-log-summary"]'), 180000, 200)
      await H.sleep(900)`
  },
  {
    // A past run reopened later: the log comes from the persisted file (jobs:runLog).
    name: '15c-job-log-reopened',
    script: `
      const run = S.jobs.runs.find((r) => r.jobName === ${JSON.stringify(LIVE_JOB)})
      if (!run) throw new Error('live job run not found')
      await H.click('[data-test="run-log-close"]', 5000)
      delete S.jobLogs.buffers[run.id]
      await H.click('[data-test="run-history"] [data-test="run-open-log"]', 5000)
      await H.until(() => H.$('[data-test="run-log-summary"]'), 10000)
      const body = await H.waitFor('[data-test="run-log-body"]', 5000)
      body.scrollTop = 0
      body.dispatchEvent(new Event('scroll'))
      await H.sleep(600)`,
    cleanup: `
      const c = H.local(S)
      await S.api.invokeSilent('db:execute', c.id, 'DROP DATABASE IF EXISTS ${BIG_SCHEMA}', {})`
  },
  {
    // A 20k-line log (cap of the panel): only blocks near the viewport are in the DOM;
    // scrolled to the middle, the visible area must still be filled with lines.
    name: '15d-job-log-large',
    script: `
      const run = S.jobs.runs.find((r) => r.jobName === ${JSON.stringify(LIVE_JOB)})
      if (!run) throw new Error('live job run not found')
      await H.until(() => S.jobLogs.get(run.id) && !S.jobLogs.get(run.id).loading, 10000)
      const buf = S.jobLogs.get(run.id)
      const lines = []
      for (let i = 0; i < 20000; i++) {
        if (i % 500 === 0) lines.push('[18:30:00] Paso ' + (i / 500 + 1) + '/40 · Base de datos big' + i / 500 + ' (Local Test)')
        else lines.push('[18:30:00]   Tabla t' + i + ' ' + '.'.repeat(Math.max(3, 41 - String(i).length)) + ' ' + (String(i) + ' filas').padStart(16) + '  OK')
      }
      S.jobLogs.append({ runId: run.id, seq: buf.offset + buf.lines.length, lines })
      const body = await H.waitFor('[data-test="run-log-body"]', 5000)
      await H.sleep(400)
      body.scrollTop = Math.round(body.scrollHeight / 2)
      body.dispatchEvent(new Event('scroll'))
      await H.sleep(500)
      const rendered = document.querySelectorAll('[data-test="run-log-line"]').length
      if (rendered > 1500) throw new Error('log not windowed: ' + rendered + ' lines in the DOM')`,
    cleanup: `
      const run = S.jobs.runs.find((r) => r.jobName === ${JSON.stringify(LIVE_JOB)})
      if (run) delete S.jobLogs.buffers[run.id]`
  },
  {
    name: '15-light-theme-home',
    script: `
      // Last step: drop the work tabs (no guards needed in a scratch profile) for a clean home.
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.showObjects()
      S.tree.select(null)
      S.settings.settings = { ...S.settings.settings, theme: 'light' }
      await H.settle(S, 1200)`,
    cleanup: `S.settings.settings = { ...S.settings.settings, theme: 'dark' }`
  }
]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function wrap(body: string): string {
  return `(async () => { const S = window.__electronDBShots; const H = window.__ndShotHelpers; ${body}\n; return true })()`
}

/**
 * Drives the renderer through every screen, writes `<dir>/<step>.png`, prints
 * a `[screenshots] {json}` summary and quits (0 when at least one PNG was saved).
 */
export function watchScreenshots(win: BrowserWindow, dir: string): void {
  const contents = win.webContents
  const say = (msg: string): void => console.log(`[screenshots] ${msg}`)
  contents.on('console-message', (event) => {
    const { level, message } = event as unknown as { level: string; message: string }
    if (level === 'error') say(`renderer error: ${message.slice(0, 300)}`)
  })

  const run = async (): Promise<void> => {
    mkdirSync(dir, { recursive: true })
    const files: string[] = []
    const failed: { step: string; error: string }[] = []
    await contents.executeJavaScript(HELPERS)
    await contents.executeJavaScript(
      wrap(
        `await H.until(() => S && S.connections.loaded && S.settings.loaded, 20000); await H.sleep(800)`
      )
    )
    // ELECTRONDB_SHOTS_ONLY=05,05b runs just the steps whose name starts with one of the prefixes.
    const only = (envVar('SHOTS_ONLY') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const steps = only.length ? STEPS.filter((s) => only.some((p) => s.name.startsWith(p))) : STEPS
    for (const step of steps) {
      if (step.size) {
        win.setContentSize(step.size.width, step.size.height)
        await sleep(500)
      }
      try {
        await contents.executeJavaScript(wrap(step.script))
        if (step.settleMs) await sleep(step.settleMs)
        // Let the compositor paint the last frame (transitions are <= 180ms).
        await sleep(350)
        let image = await contents.capturePage()
        const size = image.getSize()
        if (size.width > SCREENSHOT_WINDOW.width)
          image = image.resize({ width: SCREENSHOT_WINDOW.width, quality: 'best' })
        const file = join(dir, `${step.name}.png`)
        writeFileSync(file, image.toPNG())
        files.push(file)
        say(`saved ${file}`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failed.push({ step: step.name, error })
        say(`FAILED ${step.name}: ${error}`)
      }
      if (step.cleanup) {
        try {
          await contents.executeJavaScript(wrap(step.cleanup))
          await sleep(450)
        } catch (err) {
          say(`cleanup of ${step.name} failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (step.size) {
        win.setContentSize(SCREENSHOT_WINDOW.width, SCREENSHOT_WINDOW.height)
        await sleep(500)
      }
    }
    say(JSON.stringify({ ok: failed.length === 0, files, failed }))
    app.exit(files.length > 0 ? 0 : 1)
  }

  contents.once('did-finish-load', () => {
    run().catch((err) => {
      say(`aborted: ${err instanceof Error ? err.message : err}`)
      app.exit(1)
    })
  })
  // Never hang.
  setTimeout(() => {
    say('timeout: harness did not finish in 5 minutes')
    app.exit(1)
  }, 300_000).unref()
}
