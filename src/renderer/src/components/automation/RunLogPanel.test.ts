import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { JOB_LOG_MAX_LINES, objectLine, stampLine } from '@shared/jobLog'
import type { JobRun } from '@shared/types'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'
import { useJobLogsStore } from '@renderer/stores/jobLogs'
import { useJobsStore } from '@renderer/stores/jobs'
import RunHistory from './RunHistory.vue'
import RunLogPanel from './RunLogPanel.vue'
import { useProgressStore } from '@renderer/stores/progress'

const at = new Date(2026, 9, 5, 17, 38, 14)
const L = (body: string): string => stampLine(at, body)

const FAILED_LOG = [
  L('Inicio de «Diario» · 05/10/2026 · manual · 2 pasos'),
  L('Paso 1/2 · Base de datos accounts (Local)'),
  L(objectLine({ type: 'Table', name: 'user', count: 1234, status: 'ok' })),
  L(objectLine({ type: 'View', name: 'v_people', count: null, status: 'ok' })),
  L('  Resultado: OK · 2 objetos · 1.234 filas · 2,0 KB · 1,0 s'),
  L('Paso 2/2 · Base de datos nope (Local)'),
  L("  Resultado: ERROR · Unknown database 'nope' · 0,1 s"),
  L('Resumen'),
  L('  Pasos: 2 · Correctos: 1 · Con error: 1 · Cancelados: 0 · Omitidos: 0'),
  L("  ERROR · Paso 2/2 · Base de datos nope (Local): Unknown database 'nope'"),
  L('  Duración total: 1,1 s'),
  L('Finalizado con errores: 1 de 2 pasos con error.')
]

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: 'run-1',
    jobId: 'job-1',
    jobName: 'Diario',
    status: 'failed',
    trigger: 'manual',
    startedAt: '2026-10-05T15:38:10.000Z',
    finishedAt: '2026-10-05T15:38:12.000Z',
    tasks: [
      {
        taskId: 't1',
        referenceName: 'Backup accounts',
        status: 'running',
        startedAt: null,
        finishedAt: null,
        message: null,
        outputPath: null
      }
    ],
    logPath: '/tmp/logs/jobs/run-1.log',
    ...overrides
  }
}

/** jsdom has no layout: fake a scroll box whose height grows with its lines. */
function fakeScrollBox(el: HTMLElement, lineHeight = 20, clientHeight = 100): void {
  let top = 0
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => el.querySelectorAll('.run-log__line').length * lineHeight + clientHeight
  })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, el.scrollHeight - clientHeight))
    }
  })
}

describe('RunLogPanel', () => {
  let bridge: MockBridge
  let wrapper: VueWrapper | null = null
  let fileText = ''

  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
    fileText = FAILED_LOG.join('\n') + '\n'
    bridge = installBridge({ 'jobs:runLog': () => fileText, 'app:showInFolder': undefined })
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  const mountPanel = (props: { run: JobRun }) =>
    mount(RunLogPanel, { props, global: { plugins: [createTestVuetify()] } })

  it('renders database headings, OK/ERROR tokens and a red summary listing failures', async () => {
    wrapper = mountPanel({ run: run() })
    await flush()
    await flush()
    expect(bridge.invoke).toHaveBeenCalledWith('jobs:runLog', 'run-1')
    const headings = wrapper.findAll('.run-log__line--heading')
    expect(headings.map((h) => h.text())).toEqual([
      '17:38:14Paso 1/2 · Base de datos accounts (Local)',
      '17:38:14Paso 2/2 · Base de datos nope (Local)'
    ])
    const ok = wrapper.findAll('.run-log__token--ok')
    expect(ok.map((t) => t.text())).toEqual(['OK', 'OK', 'OK'])
    const errors = wrapper.findAll('[data-test="run-log-line"] .run-log__token--error')
    expect(errors).toHaveLength(1)
    expect(errors[0].element.parentElement?.textContent).toContain("Unknown database 'nope'")

    const summary = wrapper.get('[data-test="run-log-summary"]')
    expect(summary.classes()).toContain('run-log__summary--error')
    expect(summary.text()).toContain('ERROR · Paso 2/2 · Base de datos nope (Local)')
    expect(summary.text()).toContain('Finalizado con errores: 1 de 2 pasos con error.')
    // Summary lines are not repeated in the body.
    expect(wrapper.findAll('[data-test="run-log-line"]')).toHaveLength(7)
    expect(wrapper.find('[data-test="run-log-live"]').exists()).toBe(false)

    await wrapper.get('[data-test="run-log-reveal"]').trigger('click')
    expect(bridge.invoke).toHaveBeenCalledWith('app:showInFolder', '/tmp/logs/jobs/run-1.log')
  })

  it('shows a green summary when every step succeeded', async () => {
    fileText = [
      L('Paso 1/1 · Base de datos accounts (Local)'),
      L('  Resultado: OK · 1 objeto · 0 filas · 1,0 KB · 1,0 s'),
      L('Resumen'),
      L('  Pasos: 1 · Correctos: 1 · Con error: 0 · Cancelados: 0 · Omitidos: 0'),
      L('Finalizado correctamente: 1 de 1 paso OK.')
    ].join('\n')
    wrapper = mountPanel({ run: run({ status: 'success' }) })
    await flush()
    await flush()
    expect(wrapper.get('[data-test="run-log-summary"]').classes()).toContain('run-log__summary--ok')
  })

  it('fills in live, follows new lines and pauses auto-scroll when the user scrolls up', async () => {
    fileText = FAILED_LOG.slice(0, 2).join('\n') + '\n'
    const logs = useJobLogsStore()
    logs.listen()
    wrapper = mountPanel({ run: run({ status: 'running', finishedAt: null }) })
    await flush()
    await flush()
    const body = wrapper.get('[data-test="run-log-body"]').element as HTMLElement
    fakeScrollBox(body)
    expect(wrapper.find('[data-test="run-log-live"]').exists()).toBe(true)

    const more = (seq: number, n: number) =>
      bridge.emit('event:jobLog', {
        runId: 'run-1',
        seq,
        lines: Array.from({ length: n }, (_, i) =>
          L(objectLine({ type: 'Table', name: `t${seq + i}`, count: i, status: 'ok' }))
        )
      })
    more(2, 10)
    await flush()
    expect(wrapper.findAll('[data-test="run-log-line"]')).toHaveLength(12)
    expect(body.scrollTop).toBe(body.scrollHeight - body.clientHeight)
    expect(wrapper.find('[data-test="run-log-follow"]').exists()).toBe(false)

    // The user scrolls up: new lines no longer move the view.
    body.scrollTop = 0
    await wrapper.get('[data-test="run-log-body"]').trigger('scroll')
    more(12, 5)
    await flush()
    expect(wrapper.findAll('[data-test="run-log-line"]')).toHaveLength(17)
    expect(body.scrollTop).toBe(0)
    const follow = wrapper.get('[data-test="run-log-follow"]')
    await follow.trigger('click')
    expect(body.scrollTop).toBe(body.scrollHeight - body.clientHeight)
    await flush()
    expect(wrapper.find('[data-test="run-log-follow"]').exists()).toBe(false)
  })

  it('renders a 20k-line log in windows and only patches the block that grows', async () => {
    const logs = useJobLogsStore()
    logs.listen()
    const line = (i: number) =>
      L(objectLine({ type: 'Table', name: `t${i}`, count: i, status: 'ok' }))
    bridge.emit('event:jobLog', {
      runId: 'run-1',
      seq: 0,
      lines: Array.from({ length: JOB_LOG_MAX_LINES }, (_, i) => line(i))
    })
    const started = performance.now()
    wrapper = mountPanel({ run: run({ status: 'running', finishedAt: null }) })
    await flush()
    const mountMs = performance.now() - started
    const rendered = wrapper.findAll('[data-test="run-log-line"]')
    // Only the blocks at the end are in the DOM, not 20.000 lines.
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThanOrEqual(300)
    expect(rendered.at(-1)!.text()).toContain(`t${JOB_LOG_MAX_LINES - 1}`)
    const spacers = wrapper.findAll('.run-log__spacer')
    expect(spacers.length).toBeGreaterThan(0)
    const near = rendered.find((r) => r.text().includes(`Tabla t${JOB_LOG_MAX_LINES - 5} `))!
    const nearText = near.element.textContent

    // A batch past the cap trims the front: keys are line numbers, so existing rows keep their DOM node and text.
    bridge.emit('event:jobLog', {
      runId: 'run-1',
      seq: JOB_LOG_MAX_LINES,
      lines: Array.from({ length: 20 }, (_, i) => line(JOB_LOG_MAX_LINES + i))
    })
    await flush()
    expect(wrapper.element.contains(near.element)).toBe(true)
    expect(near.element.textContent).toBe(nearText)
    const after = wrapper.findAll('[data-test="run-log-line"]')
    expect(after.length).toBeLessThanOrEqual(300)
    expect(after.at(-1)!.text()).toContain(`t${JOB_LOG_MAX_LINES + 19}`)
    expect(wrapper.get('[data-test="run-log-trimmed"]').text()).toContain('20 primeras')
    // Generous bound (was ~6 s in jsdom when every line was rendered).
    expect(mountMs).toBeLessThan(3000)
  })

  it('copies the whole log', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    wrapper = mountPanel({ run: run() })
    await flush()
    await flush()
    await wrapper.get('[data-test="run-log-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(FAILED_LOG.join('\n'))
  })
})

describe('RunHistory', () => {
  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
  })

  it('puts Cancelar in the live progress row, away from the status pill, and opens logs inline', async () => {
    const active = run({ status: 'running', finishedAt: null })
    installBridge({ 'jobs:runs': () => [active], 'jobs:cancel': undefined })
    useJobsStore().upsertRun(active)
    useProgressStore().apply({
      operationId: 'run-1',
      kind: 'job',
      phase: 'rows',
      current: 0,
      total: 2,
      message: '',
      done: false,
      detail: {
        step: 1,
        steps: 2,
        stepLabel: 'accounts',
        objectType: 'Table',
        objectName: 'user',
        objectIndex: 1,
        objects: 4,
        objectsDone: 0,
        rows: 5000
      }
    })
    const wrapper = mount(RunHistory, {
      props: { jobId: 'job-1', jobName: 'Diario', inlineLog: true },
      global: { plugins: [createTestVuetify()] }
    })
    await flush()
    const card = wrapper.get('.timeline__card')
    expect(card.get('.timeline__row').find('[data-test="run-cancel"]').exists()).toBe(false)
    expect(card.get('.timeline__actions').find('[data-test="run-cancel"]').exists()).toBe(false)
    const live = card.get('[data-test="run-live"]')
    expect(live.find('[data-test="run-cancel"]').exists()).toBe(true)
    expect(live.text()).toContain('Paso 1/2 · accounts · Tabla user (1/4) · 5.000 filas')

    await wrapper.get('[data-test="run-open-log"]').trigger('click')
    expect(wrapper.emitted('openLog')?.[0]).toEqual([expect.objectContaining({ id: 'run-1' })])
    wrapper.unmount()
  })
})
