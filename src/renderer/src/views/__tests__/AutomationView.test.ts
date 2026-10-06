import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Job, JobRun } from '@shared/types'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills
} from '@renderer/__tests__/shellTestUtils'
import { useJobLogsStore } from '@renderer/stores/jobLogs'
import { useJobsStore } from '@renderer/stores/jobs'
import AutomationView from '../AutomationView.vue'

const job: Job = {
  id: 'job-1',
  name: 'Backup Local',
  continueOnError: true,
  tasks: [
    {
      id: 't1',
      type: 'backupschema',
      connectionId: 'c1',
      schema: 'accounts',
      referenceName: 'Backup accounts'
    }
  ],
  schedule: { enabled: false, cron: '', launchAgent: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunAt: null
}

const started: JobRun = {
  id: 'run-9',
  jobId: 'job-1',
  jobName: 'Backup Local',
  status: 'running',
  trigger: 'manual',
  startedAt: '2026-10-05T15:38:10.000Z',
  finishedAt: null,
  tasks: [],
  logPath: '/tmp/run-9.log'
}

describe('AutomationView', () => {
  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
  })

  it('opens the live log of the run started with «Ejecutar ahora»', async () => {
    const bridge = installBridge({
      'jobs:list': () => [job],
      'jobs:runs': () => [],
      'jobs:scheduleStatus': () => ({ inApp: false, launchAgent: false, nextRun: null }),
      'jobs:run': () => started,
      'jobs:runLog': () => '[17:38:10] Inicio de «Backup Local» · 05/10/2026 · manual · 1 paso\n'
    })
    useJobLogsStore().listen()
    useJobsStore().listen()
    const wrapper = mount(AutomationView, {
      props: { tab: { id: 'automation', kind: 'automation', title: 'Automatización' } as never },
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    await flush()
    expect(wrapper.find('[data-test="run-log-panel"]').exists()).toBe(false)

    await wrapper.get('[data-test="automation-view"] tbody tr').trigger('click')
    await wrapper.get('[data-test="jobs-run"]').trigger('click')
    await flush()
    await flush()
    expect(bridge.invoke).toHaveBeenCalledWith('jobs:run', 'job-1', { confirmProduction: true })
    const panel = wrapper.get('[data-test="run-log-panel"]')
    expect(wrapper.get('[data-test="automation-body"]').classes()).toContain(
      'automation-view__body--log'
    )
    bridge.emit('event:jobLog', {
      runId: 'run-9',
      seq: 1,
      lines: ['[17:38:10] Paso 1/1 · Base de datos accounts (Local)']
    })
    await flush()
    expect(panel.text()).toContain('Paso 1/1 · Base de datos accounts (Local)')
    expect(panel.text()).toContain('Inicio de «Backup Local»')

    await wrapper.get('[data-test="run-log-close"]').trigger('click')
    expect(wrapper.find('[data-test="run-log-panel"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lists restores without a job under «Restauraciones manuales» and shows their history', async () => {
    const manual: JobRun = {
      ...started,
      id: 'rb-manual',
      jobId: 'manual-rollbacks',
      jobName: 'Rollback a Local · backup-staging · 2026-10-05 23:16',
      status: 'success',
      kind: 'rollback',
      finishedAt: '2026-10-05T15:40:00.000Z'
    }
    // A run whose job no longer exists must not break anything either.
    const orphan: JobRun = { ...started, id: 'orphan', jobId: 'deleted-job', status: 'success' }
    installBridge({
      'jobs:list': () => [job],
      'jobs:runs': (jobId: unknown) =>
        jobId === 'manual-rollbacks' ? [manual] : jobId ? [] : [manual, orphan],
      'jobs:scheduleStatus': () => ({ inApp: false, launchAgent: false, nextRun: null })
    })
    const wrapper = mount(AutomationView, {
      props: { tab: { id: 'automation', kind: 'automation', title: 'Automatización' } as never },
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    await flush()
    const entry = wrapper.get('[data-test="jobs-manual-rollbacks"]')
    expect(entry.text()).toContain('Restauraciones manuales')
    await entry.trigger('click')
    await flush()
    await flush()
    const history = wrapper.get('[data-test="run-history"]')
    expect(history.text()).toContain('Restauraciones manuales')
    expect(history.find('[data-test="run-kind-rollback"]').exists()).toBe(true)
    // Not a job: nothing to edit, run or delete.
    for (const id of ['jobs-edit', 'jobs-run', 'jobs-delete'])
      expect(wrapper.get(`[data-test="${id}"]`).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
